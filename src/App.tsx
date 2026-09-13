import { Component, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react';
import { api, clearApiSession } from './lib/api';
import { supabase } from './lib/supabase';
import {
  Bell,
  CalendarDays,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock3,
  Download,
  FileText,
  Filter,
  FolderOpen,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  ReceiptText,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  Upload,
  UserPlus,
  Paperclip,
  WalletCards,
  X,
} from 'lucide-react';

type Recovery = {
  id: string;
  title: string;
  counterpartyName: string;
  type: string;
  amountMinor: number;
  recoveredMinor: number;
  currency: string;
  expectedDate: string;
  status: string;
  priority: string;
  ownerId: string;
  description?: string;
  reference?: string;
  createdAt: string;
  updatedAt: string;
};
type Dashboard = {
  totals: {
    recoverable: number;
    outstanding: number;
    overdue: number;
    recovered: number;
    recoveryRate: number;
  };
  mixedCurrency?: boolean;
  counts: { total: number; overdue: number; dueSoon: number; partial: number };
  recent: Recovery[];
  attention: Recovery[];
  currency: string;
};
type User = { userId: string; email?: string; name?: string };

// Keep auth email links pointed at the live AppDeploy customer app. Change this single constant when the app moves to its final custom domain.
const AUTH_REDIRECT_URL = 'https://recovely.vercel.app/';
const PASSWORD_RESET_REDIRECT_URL = 'https://recovely.vercel.app/?reset=1';

const nav = [
  ['overview', 'Overview', LayoutDashboard],
  ['settings', 'Settings', Settings],
  ['recoveries', 'Recoveries', Target],
  ['attention', 'Attention', CircleAlert],
  ['calendar', 'Calendar', CalendarDays],
  ['counterparties', 'Counterparties', Users],
  ['analytics', 'Analytics', Sparkles],
  ['reports', 'Reports', FileText],
  ['inbox', 'Inbox', Bell],
  ['import', 'Import', Upload],
  ['team', 'Team', Users],
  ['billing', 'Billing', WalletCards],
] as const;
const types = [
  'Supplier Credit',
  'Refund',
  'Duplicate Payment',
  'Overpayment',
  'Shipping Refund',
  'Marketplace Reimbursement',
  'Insurance Recovery',
  'Rebate',
  'Pricing Correction',
  'Tax Correction',
  'Warranty Recovery',
  'Service/SLA Credit',
  'Damaged Goods',
  'Missing Goods',
  'Short Shipment',
  'Returned Goods',
  'Other',
];
const statuses = [
  'Identified',
  'Preparing',
  'Submitted',
  'Acknowledged',
  'Under Review',
  'Promised',
  'Due',
  'Overdue',
  'Partially Recovered',
  'Recovered',
  'Verified',
  'Closed',
  'Paused',
  'Disputed',
  'Cancelled',
  'Written Off',
];
const currencies = ['USD', 'EUR', 'GBP', 'NGN', 'CAD', 'AUD'];

const toMinorUnits = (value: string, allowZero = false) => {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) return null;
  return allowZero ? minor : minor > 0 ? minor : null;
};
const money = (minor: number, currency: string) => {
  const normalizedCurrency = typeof currency === 'string' && currencies.includes(currency.toUpperCase())
    ? currency.toUpperCase()
    : 'USD';
  const numericMinor = Number(minor);
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: normalizedCurrency,
    maximumFractionDigits: 2,
  }).format((Number.isFinite(numericMinor) ? numericMinor : 0) / 100);
};
const initials = (name?: string) =>
  (name || 'U')
    .split(/\s+/)
    .slice(0, 2)
    .map(x => x[0])
    .join('')
    .toUpperCase();

class AppErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Recovely workspace render failed', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f7f8fa', color: '#18212f' }}>
          <div style={{ width: '100%', maxWidth: 520, background: '#fff', border: '1px solid #dfe3e8', borderRadius: 16, padding: 28, boxShadow: '0 12px 32px rgba(24,33,47,.08)' }}>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: '#667085', marginBottom: 10 }}>Recovely</div>
            <h1 style={{ margin: 0, fontSize: 28 }}>Your workspace hit a loading error.</h1>
            <p style={{ color: '#667085', lineHeight: 1.6 }}>Your account is still safe. Reload the workspace and try again. If this keeps happening, use Support / help in Feedback so we can investigate it.</p>
            <button className="btn primary" onClick={() => window.location.reload()}>Reload workspace</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [workspace, setWorkspace] = useState<any>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [recoveries, setRecoveries] = useState<Recovery[]>([]);
  const [page, setPage] = useState(
    window.location.hash.replace('#', '') || 'overview'
  );
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState<Recovery | null>(null);
  const [toast, setToast] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  let refreshInFlight: Promise<void> | null = null;
  const refresh = async () => {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) return;
    const results = await Promise.allSettled([
      api.get('/api/bootstrap'),
      api.get('/api/dashboard'),
      api.get('/api/recoveries'),
    ]);
    const [boot, dash, rec] = results;
    if (boot.status === 'rejected') {
      console.error('Workspace bootstrap failed', boot.reason);
      throw boot.reason;
    }
    const rawDashboard = dash.status === 'fulfilled' ? dash.value.data || {} : {};
    if (dash.status === 'rejected') console.error('Dashboard refresh failed', dash.reason);
    if (rec.status === 'rejected') console.error('Recovery list refresh failed', rec.reason);
    const rawTotals = rawDashboard.totals || {};
    const rawCounts = rawDashboard.counts || {};
    const normalizedDashboard: Dashboard = {
      totals: {
        recoverable: Number(rawTotals.recoverable) || 0,
        outstanding: Number(rawTotals.outstanding) || 0,
        overdue: Number(rawTotals.overdue) || 0,
        recovered: Number(rawTotals.recovered) || 0,
        recoveryRate: Number(rawTotals.recoveryRate) || 0,
      },
      counts: {
        total: Number(rawCounts.total) || 0,
        overdue: Number(rawCounts.overdue) || 0,
        dueSoon: Number(rawCounts.dueSoon) || 0,
        partial: Number(rawCounts.partial) || 0,
      },
      recent: Array.isArray(rawDashboard.recent) ? rawDashboard.recent : [],
      attention: Array.isArray(rawDashboard.attention) ? rawDashboard.attention : [],
      currency: typeof rawDashboard.currency === 'string' && rawDashboard.currency ? rawDashboard.currency : 'USD',
      mixedCurrency: Boolean(rawDashboard.mixedCurrency),
    };
    setWorkspace(boot.value.data.workspace);
    setUser(boot.value.data.user);
    setDashboard(normalizedDashboard);
    setRecoveries(rec.status === 'fulfilled' && Array.isArray(rec.value.data?.items) ? })().finally(() => {
      })().finally(() => {
      refreshInFlight = null;
    });

    return refreshInFlight;
  };
  useEffect(() => {
    let alive = true;
    const loadSession = async () => {
      try {
        const resetRequested = new URLSearchParams(window.location.search).get('reset') === '1' || window.location.hash === '#reset-password';
        if (resetRequested) {
          if (alive) { setPasswordRecovery(true); setSignedIn(false); }
          return;
        }
        const { data } = await supabase.auth.getUser();
        if (!alive) return;
        if (data.user) {
          const nextUser = { userId: data.user.id, email: data.user.email, name: data.user.user_metadata?.full_name || data.user.email?.split('@')[0] };
          setUser(nextUser);
          await refresh();
          if (alive) setSignedIn(true);
        } else {
          setSignedIn(false);
        }
      } catch (error) {
        console.error('Session bootstrap failed', error);
        if (alive) setSignedIn(false);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void loadSession();
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      const resetRequested = new URLSearchParams(window.location.search).get('reset') === '1' || window.location.hash === '#reset-password';
      if (event === 'PASSWORD_RECOVERY' || resetRequested) {
        setPasswordRecovery(true);
        setSignedIn(false);
        setUser(null);
        setWorkspace(null);
        setDashboard(null);
        setRecoveries([]);
        return;
      }
      if (event === 'SIGNED_OUT' || !session) {
        setPasswordRecovery(false);
        setSignedIn(false);
        setUser(null);
        setWorkspace(null);
        setDashboard(null);
        setRecoveries([]);
        return;
      }
      const nextUser = { userId: session.user.id, email: session.user.email, name: session.user.user_metadata?.full_name || session.user.email?.split('@')[0] };
      setUser(nextUser);
      setTimeout(() => {
  void (async () => {
    try {
      await refresh();
      setSignedIn(true);
    } catch (error) {
      console.error('Authenticated workspace bootstrap failed', error);
      setSignedIn(false);
      setUser(null);
    }
  })();
}, 0);
    });
    const onHash = () => setPage(window.location.hash.replace('#', '') || 'overview');
    window.addEventListener('hashchange', onHash);
    return () => {
      alive = false;
      listener.subscription.unsubscribe();
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 2800);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [mobileMenuOpen]);

  const filtered = useMemo(
    () =>
      recoveries.filter(
        r =>
          (statusFilter === 'All' || r.status === statusFilter) &&
          (!query ||
            `${r.title} ${r.counterpartyName} ${r.reference || ''}`
              .toLowerCase()
              .includes(query.toLowerCase()))
      ),
    [recoveries, query, statusFilter]
  );

  if (loading)
    return (
      <div className="boot">
        <div className="mark">R</div>
        <div className="loader-line" />
        <span>Loading your recovery workspace…</span>
      </div>
    );
  if (!signedIn)
    return (
      <Landing
        passwordRecovery={passwordRecovery}
        onAuthenticated={async () => {
          window.location.hash = 'overview';
          setPage('overview');
          try {
            await refresh();
            setSignedIn(true);
          } catch (error) {
            console.error('Workspace refresh failed after authentication', error);
            setSignedIn(false);
            setToast('Signed in, but your workspace could not be loaded. Please try again.');
          }
        }}
      />
    );

  const logout = async () => {
    await clearApiSession();
    await supabase.auth.signOut();
    setSignedIn(false);
    setUser(null);
    setWorkspace(null);
    setDashboard(null);
    setRecoveries([]);
  };
  const go = (p: string) => {
    window.location.hash = p;
    setMobileMenuOpen(false);
  };

  return (
    <div className="app-shell">
      {mobileMenuOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMobileMenuOpen(false)} />}
      <aside className={mobileMenuOpen ? 'sidebar mobile-open' : 'sidebar'}>
        <div className="brand">
          <div className="brand-mark">R</div>
          <div>
            <strong>recovely</strong>
            <span>Recovery operations</span>
          </div>
        </div>
        <div className="workspace-switch">
          <div className="workspace-avatar">{initials(workspace?.name)}</div>
          <div className="workspace-meta">
            <b>{workspace?.name || 'My workspace'}</b>
            <span>{workspace?.plan ? `${String(workspace.plan).charAt(0).toUpperCase()}${String(workspace.plan).slice(1)} plan` : 'Workspace'}</span>
          </div>
          <ChevronDown size={15} />
        </div>
        <nav>
          {nav.map(([id, label, Icon]) => (
            <button
              key={id}
              className={page === id ? 'nav-item active' : 'nav-item'}
              onClick={() => go(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === 'attention' && (dashboard?.counts.overdue || 0) > 0 && (
                <em>{dashboard?.counts.overdue}</em>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => go('help')}>
            <LifeBuoy size={18} />
            <span>Support</span>
          </button>
          <button className="nav-item" onClick={() => go('feedback')}>
            <Sparkles size={18} />
            <span>Feedback</span>
          </button>
          <div className="profile">
            <div className="avatar">{initials(user?.name || user?.email)}</div>
            <div>
              <b>{user?.name || 'Account'}</b>
              <span>{user?.email || ''}</span>
            </div>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <button
            className="mobile-menu"
            aria-label="Open navigation"
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen(v => !v)}
          >
            <Menu size={20} />
          </button>
          <div className="crumb">
            {nav.find(n => n[0] === page)?.[1] ||
              (page === 'settings' ? 'Settings' : 'Support')}
          </div>
          <div className="top-actions">
            <button className="icon-btn" onClick={() => go('inbox')}>
              <Bell size={18} />
              {dashboard?.counts.overdue ? <i /> : null}
            </button>
            <button className="user-chip" onClick={() => go('settings')}>
              <span>{initials(user?.name || user?.email)}</span>
              {user?.name || 'Account'}
            </button>
          </div>
        </header>
        <div className="content">
          {page === 'overview' && (
            <Overview
              dashboard={dashboard}
              workspace={workspace}
              onAdd={() => setShowAdd(true)}
              onOpen={setSelected}
              go={go}
            />
          )}
          {page === 'recoveries' && (
            <RecoveriesPage
              items={filtered}
              query={query}
              setQuery={setQuery}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              onAdd={() => setShowAdd(true)}
              onOpen={setSelected}
              onExport={async () => {
                const r = await api.get('/api/recoveries/export');
                const blob = new Blob([r.data.csv], { type: 'text/csv' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'recovely-recoveries.csv';
                a.click();
                URL.revokeObjectURL(a.href);
              }}
            />
          )}
          {page === 'attention' && (
            <AttentionPage
              items={dashboard?.attention || []}
              onOpen={setSelected}
              onAdd={() => setShowAdd(true)}
            />
          )}
          {page === 'calendar' && (
            <CalendarPage items={recoveries} onOpen={setSelected} />
          )}
          {page === 'counterparties' && <CounterpartiesPage />}
          {page === 'analytics' && <AnalyticsPage dashboard={dashboard} />}
          {page === 'reports' && <ReportsPage dashboard={dashboard} />}
          {page === 'inbox' && <InboxPage onOpenRecovery={setSelected} />}
          {page === 'import' && <ImportPage onImported={refresh} onUpgrade={() => go('billing')} />}
          {page === 'team' && <TeamPage />}
          {page === 'billing' && <BillingPage />}
          {page === 'feedback' && <FeedbackPage />}
          {page === 'settings' && (
            <SettingsPage workspace={workspace} refresh={refresh} onSignOut={logout} />
          )}
          {page === 'help' && <HelpPage onFeedback={() => go('feedback')} />}
        </div>
      </main>
      {showAdd && (
        <AddRecovery
          onClose={() => setShowAdd(false)}
          onUpgrade={() => { setShowAdd(false); go('billing'); }}
          onSaved={async () => {
            setShowAdd(false);
            await refresh();
            setToast('Recovery added and now visible in your workspace.');
          }}
        />
      )}
      {selected && (
        <RecoveryDrawer
          recovery={selected}
          onClose={() => setSelected(null)}
          onSaved={async () => {
            setSelected(null);
            await refresh();
            setToast('Recovery updated.');
          }}
        />
      )}
      {toast && (
        <div className="toast">
          <CircleCheck size={17} />
          {toast}
        </div>
      )}
    </div>
  );
}

function Landing({ onAuthenticated, passwordRecovery }: { onAuthenticated: () => Promise<void>; passwordRecovery?: boolean }) {
  const initialHash = window.location.hash;
  const resetRequested = passwordRecovery || new URLSearchParams(window.location.search).get('reset') === '1' || initialHash === '#reset-password';
  const [screen, setScreen] = useState<'landing' | 'auth' | 'forgot' | 'reset'>(resetRequested ? 'reset' : initialHash === '#forgot' ? 'forgot' : (initialHash === '#signin' || initialHash === '#signup') ? 'auth' : 'landing');
  const [mode, setMode] = useState<'signin' | 'signup'>(initialHash === '#signup' ? 'signup' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [resetCooldown, setResetCooldown] = useState(0);

  useEffect(() => {
    if (passwordRecovery) {
      setScreen('reset');
      setMessage('');
    }
  }, [passwordRecovery]);

  useEffect(() => {
    if (resetCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setResetCooldown(current => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resetCooldown]);

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange(event => {
      if (event === 'PASSWORD_RECOVERY') {
        setScreen('reset');
        setMessage('');
      }
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const openAuth = (nextMode: 'signin' | 'signup') => {
    setMode(nextMode);
    setScreen('auth');
    setMessage('');
    setPassword('');
    window.location.hash = nextMode === 'signup' ? 'signup' : 'signin';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const openForgot = () => {
    setScreen('forgot');
    setMessage('');
    setPassword('');
    window.location.hash = 'forgot';
  };

  const requestPasswordReset = async () => {
    if (resetCooldown > 0) {
      setMessage(`Please wait ${resetCooldown} seconds before requesting another reset link.`);
      return;
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setMessage('Enter your work email first.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const redirectTo = PASSWORD_RESET_REDIRECT_URL;
      const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, { redirectTo });
      if (error) throw error;
      setResetCooldown(60);
      setMessage('If an account exists for that email, we sent a password reset link. You can request another link after 60 seconds. Check Inbox, Spam/Junk, and Promotions.');
    } catch (error: any) {
      const rawMessage = error?.message || 'Password reset could not be requested.';
      const normalizedMessage = String(rawMessage).toLowerCase();
      if (normalizedMessage.includes('rate limit') || normalizedMessage.includes('email rate') || normalizedMessage.includes('too many') || normalizedMessage.includes('over_email_send_rate_limit') || normalizedMessage.includes('over_request_rate_limit')) {
        setResetCooldown(60);
        setMessage('Password reset email sending is temporarily rate-limited. Please wait 60 seconds before trying again. If emails still do not arrive after that, check Spam/Junk and the Supabase Auth email delivery settings.');
      } else {
        setMessage(rawMessage);
      }
    } finally {
      setBusy(false);
    }
  };

  const updatePassword = async () => {
    if (newPassword.length < 8) {
      setMessage('Your new password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage('The two new passwords do not match.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      await clearApiSession();
      await supabase.auth.signOut();
      window.history.replaceState({}, document.title, `${window.location.pathname}#signin`);
      setNewPassword('');
      setConfirmPassword('');
      setMode('signin');
      setScreen('auth');
      window.location.hash = 'signin';
      setMessage('Password updated. Sign in with your new password.');
    } catch (error: any) {
      setMessage(error?.message || 'Your password could not be updated. Please request a new reset link.');
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setMessage('');
    try {
      const redirectTo = AUTH_REDIRECT_URL;
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { full_name: fullName.trim() }, emailRedirectTo: redirectTo },
        });
        if (error) throw error;
        if (!data.session) {
          setMode('signin');
          window.location.hash = 'signin';
          setMessage('Account created. Check your email, refresh Gmail, then check Inbox, Spam/Junk, and Promotions. Confirm the email, then return here to sign in.');
          return;
        }
      } else {
        const normalizedEmail = email.trim().toLowerCase();
        const { error } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
        if (error) throw error;
      }
      await onAuthenticated();
    } catch (error: any) {
      const rawMessage = error?.message || 'Authentication could not be completed.';
      const normalizedMessage = String(rawMessage).toLowerCase();
      if (normalizedMessage.includes('invalid login credentials') || normalizedMessage.includes('invalid_credentials')) {
        setMessage('Email or password is incorrect. If you changed your password recently, use the new password. Otherwise, use Forgot password to set a new one.');
      } else if (normalizedMessage.includes('email not confirmed')) {
        setMessage('Please confirm your email address from the Recovely confirmation email, then sign in again.');
      } else if (normalizedMessage.includes('rate limit') || normalizedMessage.includes('email rate') || normalizedMessage.includes('too many')) {
        setMessage('Authentication is temporarily rate-limited. Please wait a few minutes and try again.');
      } else {
        setMessage(rawMessage);
      }
    } finally {
      setBusy(false);
    }
  };

  if (screen === 'forgot') {
    return (
      <div className="auth-screen">
        <div className="auth-screen-card">
          <button className="auth-back" onClick={() => openAuth('signin')}>← Back to sign in</button>
          <div className="auth-screen-brand"><div className="brand-mark">R</div><strong>recovely</strong></div>
          <div className="eyebrow">Password recovery</div>
          <h1>Forgot your password?</h1>
          <p className="auth-screen-copy">Enter your work email and we’ll send you a secure link to choose a new password.</p>
          <input className="auth-screen-input" aria-label="Email" type="email" placeholder="Work email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
          {message && <div className="auth-message">{message}</div>}
          <button className="btn primary big auth-submit" onClick={() => void requestPasswordReset()} disabled={busy || !email.trim() || resetCooldown > 0}>{busy ? 'Sending…' : resetCooldown > 0 ? `Send again in ${resetCooldown}s` : message ? 'Send reset link again' : 'Send reset link'}</button>
          <small className="auth-screen-note">Reset uses a secure email link, not a permanent code. Supabase requires a short resend window; Recovely shows the countdown instead of silently failing a second request.</small>
        </div>
      </div>
    );
  }

  if (screen === 'reset') {
    return (
      <div className="auth-screen">
        <div className="auth-screen-card">
          <div className="auth-screen-brand"><div className="brand-mark">R</div><strong>recovely</strong></div>
          <div className="eyebrow">Choose a new password</div>
          <h1>Reset your password</h1>
          <p className="auth-screen-copy">Choose a new password for your Recovely account.</p>
          <input className="auth-screen-input" aria-label="New password" type="password" placeholder="New password" value={newPassword} onChange={e => setNewPassword(e.target.value)} autoComplete="new-password" />
          <input className="auth-screen-input" aria-label="Confirm new password" type="password" placeholder="Confirm new password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password" />
          {message && <div className="auth-message">{message}</div>}
          <button className="btn primary big auth-submit" onClick={() => void updatePassword()} disabled={busy || newPassword.length < 8 || !confirmPassword}>{busy ? 'Updating…' : 'Update password'}</button>
        </div>
      </div>
    );
  }

  if (screen === 'auth') {
    return (
      <div className="auth-screen">
        <div className="auth-screen-card">
          <button className="auth-back" onClick={() => { setScreen('landing'); window.location.hash = ''; }}>← Back to Recovely</button>
          <div className="auth-screen-brand"><div className="brand-mark">R</div><strong>recovely</strong></div>
          <div className="eyebrow">{mode === 'signin' ? 'Welcome back' : 'Create your account'}</div>
          <h1>{mode === 'signin' ? 'Sign in to Recovely' : 'Create your Recovely account'}</h1>
          <p className="auth-screen-copy">{mode === 'signin' ? 'Access your real recovery workspace.' : 'Start with a real account. No sample records are created.'}</p>
          <div className="auth-tabs">
            <button className={mode === 'signin' ? 'active' : ''} onClick={() => openAuth('signin')}>Sign in</button>
            <button className={mode === 'signup' ? 'active' : ''} onClick={() => openAuth('signup')}>Create account</button>
          </div>
          {mode === 'signup' && <input className="auth-screen-input" aria-label="Full name" placeholder="Full name" value={fullName} onChange={e => setFullName(e.target.value)} maxLength={120} />}
          <input className="auth-screen-input" aria-label="Email" type="email" placeholder="Work email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
          <input className="auth-screen-input" aria-label="Password" type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
          {message && <div className="auth-message">{message}</div>}
          <button className="btn primary big auth-submit" onClick={() => void submit()} disabled={busy || !email.trim() || password.length < 8}>{busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}</button>
          {mode === 'signin' && <button className="auth-forgot" onClick={openForgot} disabled={busy}>Forgot password?</button>}
          <small className="auth-screen-note">Sign in with your email and password. Forgot your password? Use the secure reset link. Google sign-in is intentionally postponed until a later release.</small>
        </div>
      </div>
    );
  }

  return (
    <div className="landing">
      <div className="landing-nav">
        <div className="brand"><div className="brand-mark">R</div><strong>recovely</strong></div>
        <button className="btn secondary" onClick={() => openAuth('signin')}>Sign in</button>
      </div>
      <section className="hero">
        <div className="eyebrow"><span /> Recovery operations for money already owed to you</div>
        <h1>Stop losing track of money you already earned. <i>Bring it back.</i></h1>
        <p>Recovely gives finance and operations teams one place to discover, document, pursue and verify refunds, supplier credits, rebates, claims, duplicate payments and other recoveries.</p>
        <div className="hero-actions">
          <button className="btn primary big" onClick={() => openAuth('signup')}>Start recovering money <span>→</span></button>
          <button className="text-btn" onClick={() => openAuth('signin')}>Sign in to your workspace</button>
        </div>
        <div className="hero-note"><ShieldCheck size={15} /> Built around real records, evidence, owners and next actions.</div>
      </section>
      <section className="landing-product-frame"><div className="product-window"><div className="product-window-top"><span /><span /><span /><b>Recovely · Recovery command center</b></div><div className="product-window-body"><div className="product-window-sidebar"><i /><i /><i /><i /><i /></div><div className="product-window-main"><div className="product-window-heading"><span>Workspace overview</span><b>Live recovery operations</b></div><div className="product-window-metrics"><i /><i /><i /><i /></div><div className="product-window-panels"><div /><div /></div></div></div></div></section>
      <section className="landing-section landing-proof"><div className="section-label">The problem</div><h2>Money gets lost in the handoffs.</h2><p>Refunds sit in email. Supplier credits live in spreadsheets. Claims lose their evidence. Follow-ups depend on memory. Recovely connects the amount, evidence, owner, deadline, next action and outcome so recoverable value keeps moving until it is resolved.</p></section>
      <section className="landing-section workflow-section"><div className="section-label">The recovery lifecycle</div><h2>A recovery process that keeps moving until the outcome is real.</h2><div className="workflow-grid"><div><span>01</span><b>Discover</b><p>Identify money, credits, refunds, claims and other value your business is entitled to recover.</p></div><div><span>02</span><b>Document</b><p>Keep references, evidence and notes attached to the recovery instead of scattered across tools.</p></div><div><span>03</span><b>Act</b><p>Assign ownership, set follow-ups and keep the next operational step visible.</p></div><div><span>04</span><b>Monitor</b><p>Surface due, overdue, stalled and partially recovered work from actual workspace state.</p></div><div><span>05</span><b>Recover</b><p>Record what comes back with precise currency-aware amounts and a durable history.</p></div><div><span>06</span><b>Verify & close</b><p>Keep the final outcome and operational history accountable through completion.</p></div></div></section>
      <section className="landing-section landing-feature-grid"><div className="landing-feature-copy"><div className="section-label">Not accounting. Not debt collection.</div><h2>Recovery operations, built for the work after the transaction.</h2><p>Every recovery has a reason, an amount, a counterparty, a deadline and a next action. Recovely turns those details into one accountable operating system for getting value back.</p></div><div className="landing-feature-list"><Feature icon={WalletCards} title="Know your exposure" text="See recoverable, outstanding, overdue and recovered value from persisted records." /><Feature icon={Clock3} title="Keep deadlines visible" text="Follow-ups and expected recovery dates stay attached to the work." /><Feature icon={ShieldCheck} title="Preserve the evidence" text="Private documents and operational notes remain connected to the recovery." /><Feature icon={Target} title="Operate from signals" text="Attention and health are calculated from actual status, dates and remaining value." /></div></section>
      <section className="landing-cta"><div className="section-label">Built for accountable recovery</div><h2>If money is owed to your business, it deserves an owner, a deadline and a path back to cash.</h2><button className="btn primary big" onClick={() => openAuth('signup')}>Create your account <span>→</span></button></section>
      <footer className="landing-footer"><span>recovely</span><small>Recovery operations for finance and operations teams that want their money back.</small></footer>
    </div>
  );
}
function FeedbackPage() {
  const [category, setCategory] = useState('Feature request');
  const [requestedFeature, setRequestedFeature] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [submissions, setSubmissions] = useState<any[]>([]);
  const [canReview, setCanReview] = useState(false);

  const load = async () => {
    try {
      const response = await api.get('/api/feedback');
      setSubmissions(response.data.items || []);
      setCanReview(true);
    } catch {
      setCanReview(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const submit = async () => {
    if (message.trim().length < 10) {
      setNotice('Please tell us a little more so the feedback is useful.');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      await api.post('/api/feedback', { category, requestedFeature, message });
      setMessage('');
      setRequestedFeature('');
      setNotice('Thanks. Your feedback has been recorded for the Recovely team.');
      await load();
    } catch (error: any) {
      setNotice(error?.message || 'Feedback could not be submitted.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head"><div><div className="eyebrow">Product feedback</div><h1>Tell us what you need</h1><p>Send requests, problems, ideas and workflow needs directly from inside Recovely. We use this to decide what to improve next.</p></div></div>
      <section className="panel form-panel feedback-form">
        <label>What kind of feedback is this?<select value={category} onChange={e => setCategory(e.target.value)}><option>Support / help</option><option>Feature request</option><option>Bug report</option><option>Workflow need</option><option>General feedback</option></select></label>
        <label>Feature or capability you want<textarea value={requestedFeature} onChange={e => setRequestedFeature(e.target.value)} placeholder="Example: I need to track supplier response deadlines…" maxLength={2000} /></label>
        <label>Your message<textarea value={message} onChange={e => setMessage(e.target.value)} placeholder="Tell us what is difficult today, what you expected, or what would make Recovely more useful." maxLength={5000} /></label>
        {notice && <div className="auth-message">{notice}</div>}
        <button className="btn primary" onClick={() => void submit()} disabled={busy}>{busy ? 'Sending…' : 'Send feedback'}</button>
      </section>
      {canReview && <section className="panel" style={{ marginTop: 12 }}><div className="panel-head"><div><h2>Workspace feedback</h2><span>Recent feedback submitted by users in this workspace</span></div></div>{submissions.length ? <div>{submissions.map(item => <div className="notification-row" key={item.id}><div><b>{item.category}</b><p>{item.message}</p>{item.requestedFeature && <small>Requested: {item.requestedFeature}</small>}<small>{item.email || 'Account'} · {new Date(item.createdAt).toLocaleString()}</small></div></div>)}</div> : <div className="quiet"><b>No feedback yet</b><span>Submitted feedback will appear here for workspace owners and admins.</span></div>}</section>}
    </>
  );
}

function Feature({
  icon: Icon,
  title,
  text,
}: {
  icon: any;
  title: string;
  text: string;
}) {
  return (
    <div className="feature">
      <Icon size={20} />
      <div>
        <b>{title}</b>
        <span>{text}</span>
      </div>
    </div>
  );
}
function Overview({
  dashboard,
  workspace,
  onAdd,
  onOpen,
  go,
}: {
  dashboard: Dashboard | null;
  workspace: any;
  onAdd: () => void;
  onOpen: (r: Recovery) => void;
  go: (p: string) => void;
}) {
  const empty = !dashboard?.counts.total;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Workspace overview</div>
          <h1>Good to see you.</h1>
          <p>
            Keep every recovery visible until the value is back where it
            belongs.
          </p>
        </div>
        <button className="btn primary" onClick={onAdd}>
          <Plus size={17} /> Add recovery
        </button>
      </div>
      <div className="metric-grid">
        {[
          ['Recoverable', dashboard?.totals.recoverable || 0, 'Total identified value'],
          ['Outstanding', dashboard?.totals.outstanding || 0, 'Still expected back'],
          ['Overdue', dashboard?.totals.overdue || 0, 'Outstanding overdue value'],
          ['Recovered', dashboard?.totals.recovered || 0, 'Value returned'],
          ['Recovery rate', null, 'Recovered ÷ identified'],
          ['Due soon', dashboard?.counts.dueSoon || 0, 'Recoveries approaching deadline'],
        ].map(([l, v, s], i) => (
          <div className="metric" key={String(l)}>
            <span>{l}</span>
            <strong>
              {l === 'Recovery rate'
                ? dashboard?.mixedCurrency ? '—' : dashboard ? `${dashboard.totals.recoveryRate.toFixed(1)}%` : '—'
                : l === 'Due soon'
                  ? String(v || 0)
                  : dashboard?.mixedCurrency ? 'Multiple' : dashboard ? money(Number(v), dashboard.currency) : '—'}
            </strong>
            <small>{s}</small>
            <div className="metric-icon">
              {i === 0 ? (
                <WalletCards size={17} />
              ) : i === 1 ? (
                <Clock3 size={17} />
              ) : i === 2 ? (
                <CircleAlert size={17} />
              ) : (
                <CircleCheck size={17} />
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="dashboard-section-label"><span>OPERATING VIEW</span><b>What needs your attention now</b></div>
      <div className="split">
        <section className="panel dashboard-pipeline">
          <div className="panel-head">
            <div>
              <h2>Recovery pipeline</h2>
              <span>Real records from this workspace</span>
            </div>
            <button className="link-btn" onClick={() => go('recoveries')}>
              View all →
            </button>
          </div>
          {empty ? (
            <EmptyState onAdd={onAdd} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Recovery</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Expected</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard?.recent.slice(0, 6).map(r => (
                    <tr key={r.id} onClick={() => onOpen(r)}>
                      <td>
                        <b>{r.title}</b>
                        <span>{r.counterpartyName}</span>
                      </td>
                      <td>
                        <b>{money(r.amountMinor, r.currency)}</b>
                        <span>
                          {r.recoveredMinor
                            ? `${money(r.recoveredMinor, r.currency)} recovered`
                            : 'No recovery yet'}
                        </span>
                      </td>
                      <td>
                        <Status status={r.status} />
                      </td>
                      <td>
                        {new Date(r.expectedDate).toLocaleDateString(
                          undefined,
                          { month: 'short', day: 'numeric' }
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="panel attention-panel">
          <div className="panel-head">
            <div>
              <h2>Needs attention</h2>
              <span>Deterministic operational signals</span>
            </div>
            <CircleAlert size={18} />
          </div>
          {dashboard?.attention.length ? (
            dashboard.attention.slice(0, 5).map(r => (
              <button
                className="attention-row"
                key={r.id}
                onClick={() => onOpen(r)}
              >
                <span className="attention-dot" />
                <div>
                  <b>{r.title}</b>
                  <small>
                    {r.status === 'Overdue'
                      ? 'Overdue recovery'
                      : 'Action recommended'}{' '}
                    · {r.counterpartyName}
                  </small>
                </div>
                <strong>
                  {money(
                    Math.max(r.amountMinor - r.recoveredMinor, 0),
                    r.currency
                  )}
                </strong>
              </button>
            ))
          ) : (
            <div className="quiet">
              <CircleCheck size={22} />
              <b>Nothing needs attention.</b>
              <span>
                As your workspace grows, Recovely will surface stalled and
                overdue recoveries here.
              </span>
            </div>
          )}
        </section>
      </div>
      <div className="dashboard-section-label dashboard-lower-label"><span>RECOVERY PERFORMANCE</span><b>Turn visibility into consistent recovery work</b></div>
      <div className="bottom-grid">
        <section className="insight-card">
          <div className="insight-kicker">Recovery rate</div>
          <strong>
            {dashboard?.mixedCurrency ? '—' : dashboard ? `${dashboard.totals.recoveryRate.toFixed(1)}%` : '—'}
          </strong>
          <span>Recovered value ÷ identified value</span>
          <div className="progress">
            <i
              style={{
                width: `${Math.min(dashboard?.totals.recoveryRate || 0, 100)}%`,
              }}
            />
          </div>
        </section>
        <section className="insight-card dark">
          <div>
            <div className="insight-kicker">Operating principle</div>
            <h3>Visibility is a recovery advantage.</h3>
            <p>
              Recovely keeps the next action, evidence and expected value
              connected so nothing quietly falls out of the process.
            </p>
          </div>
          <Target size={30} />
        </section>
      </div>
    </>
  );
}
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <FolderOpen size={22} />
      </div>
      <h3>Your recovery workspace is clear.</h3>
      <p>
        When your business is owed money, add it here and Recovely will keep it
        visible until it’s resolved.
      </p>
      <button className="btn primary" onClick={onAdd}>
        <Plus size={16} /> Add your first recovery
      </button>
    </div>
  );
}
function Status({ status }: { status: string }) {
  return (
    <span
      className={`status status-${status.toLowerCase().replace(/[^a-z]+/g, '-')}`}
    >
      <i />
      {status}
    </span>
  );
}
function RecoveriesPage({
  items,
  query,
  setQuery,
  statusFilter,
  setStatusFilter,
  onAdd,
  onOpen,
  onExport,
}: {
  items: Recovery[];
  query: string;
  setQuery: (x: string) => void;
  statusFilter: string;
  setStatusFilter: (x: string) => void;
  onAdd: () => void;
  onOpen: (r: Recovery) => void;
  onExport: () => void;
}) {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Recovery operations</div>
          <h1>Recoveries</h1>
          <p>
            Every amount your business is entitled to recover, with the next
            action attached.
          </p>
        </div>
        <div className="head-actions">
          <button className="btn secondary" onClick={onExport}>
            <Download size={16} /> Export CSV
          </button>
          <button className="btn primary" onClick={onAdd}>
            <Plus size={17} /> Add recovery
          </button>
        </div>
      </div>
      <div className="toolbar">
        <div className="search">
          <Search size={17} />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search recoveries, counterparties, references…"
          />
        </div>
        <div className="filter">
          <Filter size={15} />
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
          >
            <option>All</option>
            {statuses.map(s => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>
      <section className="panel table-panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Recovery</th>
                <th>Counterparty</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Expected</th>
                <th>Priority</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map(r => (
                <tr key={r.id} onClick={() => onOpen(r)}>
                  <td>
                    <b>{r.title}</b>
                    <span>{r.type}</span>
                  </td>
                  <td>{r.counterpartyName}</td>
                  <td>
                    <b>{money(r.amountMinor, r.currency)}</b>
                    <span>
                      {r.recoveredMinor
                        ? `${money(r.recoveredMinor, r.currency)} recovered`
                        : 'Outstanding'}
                    </span>
                  </td>
                  <td>
                    <Status status={r.status} />
                  </td>
                  <td>
                    {new Date(r.expectedDate).toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </td>
                  <td>
                    <span className={`priority p-${r.priority.toLowerCase()}`}>
                      {r.priority}
                    </span>
                  </td>
                  <td>
                    <MoreHorizontal size={17} />
                  </td>
                </tr>
              ))}
              {!items.length && (
                <tr>
                  <td colSpan={7}>
                    <div className="table-empty">
                      No recoveries match your current filters.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
function AttentionPage({
  items,
  onOpen,
  onAdd,
}: {
  items: Recovery[];
  onOpen: (r: Recovery) => void;
  onAdd: () => void;
}) {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Command center</div>
          <h1>Attention</h1>
          <p>
            Operational signals calculated from your actual recovery records.
          </p>
        </div>
        <button className="btn primary" onClick={onAdd}>
          <Plus size={17} /> Add recovery
        </button>
      </div>
      {items.length ? (
        <div className="attention-grid">
          {items.map(r => (
            <button
              className="attention-card"
              key={r.id}
              onClick={() => onOpen(r)}
            >
              <div className="card-top">
                <span className="signal">
                  {r.status === 'Overdue' ? 'OVERDUE' : 'ACTION'}
                </span>
                <span>{r.priority}</span>
              </div>
              <h3>{r.title}</h3>
              <p>{r.counterpartyName}</p>
              <strong>
                {money(
                  Math.max(r.amountMinor - r.recoveredMinor, 0),
                  r.currency
                )}
              </strong>
              <small>
                {r.status === 'Overdue'
                  ? `Expected ${new Date(r.expectedDate).toLocaleDateString()}`
                  : 'Review next action'}
              </small>
            </button>
          ))}
        </div>
      ) : (
        <section className="panel large-empty">
          <CircleCheck size={32} />
          <h2>All clear.</h2>
          <p>
            No overdue, stalled or partial recoveries currently require
            attention.
          </p>
        </section>
      )}
    </>
  );
}
function CalendarPage({
  items,
  onOpen,
}: {
  items: Recovery[];
  onOpen: (r: Recovery) => void;
}) {
  const upcoming = [...items].sort((a, b) =>
    a.expectedDate.localeCompare(b.expectedDate)
  );
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Deadlines</div>
          <h1>Calendar</h1>
          <p>Expected recovery dates and operational deadlines.</p>
        </div>
      </div>
      <section className="panel calendar-list">
        {upcoming.length ? (
          upcoming.map(r => (
            <button key={r.id} onClick={() => onOpen(r)}>
              <div className="date-box">
                <b>{new Date(r.expectedDate).getDate()}</b>
                <span>
                  {new Date(r.expectedDate).toLocaleDateString(undefined, {
                    month: 'short',
                  })}
                </span>
              </div>
              <div>
                <b>{r.title}</b>
                <span>
                  {r.counterpartyName} · {r.type}
                </span>
              </div>
              <strong>
                {money(
                  Math.max(r.amountMinor - r.recoveredMinor, 0),
                  r.currency
                )}
              </strong>
              <Status status={r.status} />
            </button>
          ))
        ) : (
          <EmptyState
            onAdd={() => {
              window.location.hash = 'recoveries';
            }}
          />
        )}
      </section>
    </>
  );
}
function CounterpartiesPage() {
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => {
    api.get('/api/counterparties').then(r => setItems(r.data.items || []));
  }, []);
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Relationship intelligence</div>
          <h1>Counterparties</h1>
          <p>
            See where recoveries originate and which relationships need
            follow-through.
          </p>
        </div>
      </div>
      <section className="panel table-panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Counterparty</th>
                <th>Active recoveries</th>
                <th>Outstanding</th>
                <th>Recovered</th>
                <th>Overdue</th>
              </tr>
            </thead>
            <tbody>
              {items.map(c => (
                <tr key={c.name}>
                  <td>
                    <b>{c.name}</b>
                    <span>{c.type}</span>
                  </td>
                  <td>{c.count}</td>
                  <td>{money(c.outstandingMinor, c.currency)}</td>
                  <td>{money(c.recoveredMinor, c.currency)}</td>
                  <td>{c.overdue}</td>
                </tr>
              ))}
              {!items.length && (
                <tr>
                  <td colSpan={5}>
                    <div className="table-empty">
                      Counterparty intelligence will appear after you add
                      recoveries.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
function AnalyticsPage({ dashboard }: { dashboard: Dashboard | null }) {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Performance</div>
          <h1>Analytics</h1>
          <p>
            Measure recovered value and the exposure still in your pipeline.
          </p>
        </div>
      </div>
      <div className="analytics-grid">
        <div className="chart-card wide">
          <div className="panel-head">
            <div>
              <h2>Recovery value</h2>
              <span>
                {dashboard?.mixedCurrency ? 'Multiple currencies · no conversion applied' : `Current workspace totals · ${dashboard?.currency || 'USD'}`}
              </span>
            </div>
          </div>
          <div className="bar-chart">
            <div
              className="bar"
              style={{
                height: `${Math.max(8, dashboard?.totals.recoverable || 0 ? (dashboard!.totals.recovered / dashboard!.totals.recoverable) * 100 : 8)}%`,
              }}
            />
            <div
              className="bar muted"
              style={{
                height: `${Math.max(8, dashboard?.totals.outstanding || 0 ? (dashboard!.totals.outstanding / dashboard!.totals.recoverable) * 100 : 8)}%`,
              }}
            />
          </div>
          <div className="legend">
            <span>
              <i /> Recovered
            </span>
            <span>
              <i /> Outstanding
            </span>
          </div>
        </div>
        <div className="chart-card">
          <span className="insight-kicker">Recovery rate</span>
          <strong>{dashboard?.mixedCurrency ? '—' : dashboard?.totals.recoveryRate.toFixed(1) || '0.0'}%</strong>
          <p>{dashboard?.mixedCurrency ? 'Multiple currencies are kept separate; no silent conversion is applied.' : 'Based only on persisted recovery amounts.'}</p>
        </div>
        <div className="chart-card">
          <span className="insight-kicker">Overdue exposure</span>
          <strong>
            {dashboard?.mixedCurrency ? 'Multiple' : dashboard ? money(dashboard.totals.overdue, dashboard.currency) : '—'}
          </strong>
          <p>Outstanding value attached to overdue recoveries.</p>
        </div>
      </div>
    </>
  );
}
function ReportsPage({ dashboard }: { dashboard: Dashboard | null }) {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Reporting</div>
          <h1>Recovery operations report</h1>
          <p>
            A clean operating snapshot generated from your current workspace
            data, without silent currency conversion.
          </p>
        </div>
        <button className="btn secondary" onClick={() => window.print()}>
          <Download size={16} /> Print / PDF
        </button>
      </div>
      <section className="report panel">
        <div className="report-head">
          <div className="brand">
            <div className="brand-mark">R</div>
            <strong>recovely</strong>
          </div>
          <span>Generated from live workspace records</span>
        </div>
        <h2>Recovery operations report</h2>
        <div className="report-grid">
          {[
            ['Identified', dashboard?.totals.recoverable || 0],
            ['Recovered', dashboard?.totals.recovered || 0],
            ['Outstanding', dashboard?.totals.outstanding || 0],
            ['Overdue', dashboard?.totals.overdue || 0],
          ].map(([l, v]) => (
            <div key={String(l)}>
              <span>{l}</span>
              <strong>
                {dashboard?.mixedCurrency ? 'Multiple currencies' : dashboard ? money(Number(v), dashboard.currency) : '—'}
              </strong>
            </div>
          ))}
        </div>
        <div className="report-note">
          <ShieldCheck size={18} />
          <div>
            <b>No fabricated metrics.</b>
            <span>
              This report only uses persisted recovery records from this
              workspace. Empty workspaces remain empty.
            </span>
          </div>
        </div>
      </section>
    </>
  );
}
function ImportPage({ onImported, onUpgrade }: { onImported: () => Promise<void>; onUpgrade: () => void }) {
  const [rows, setRows] = useState<Record<string,string>[]>([]);
  const [pastedCsv, setPastedCsv] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const previewCsv = async (csv: string) => {
    setMessage('');
    setBusy(true);
    try {
      const r = await api.post('/api/import/preview', { csv });
      setPreview({ ...r.data, csv });
      setRows(parseCsv(csv));
    } catch (e:any) { setMessage(e?.message || 'Could not preview CSV.'); }
    finally { setBusy(false); }
  };
  const readFile = async (file: File) => { await previewCsv(await file.text()); };
  const pasteCsv = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { setMessage('Clipboard is empty. Copy CSV rows first, then tap Paste CSV.'); return; }
      setPastedCsv(text);
      await previewCsv(text);
    } catch { setMessage('Clipboard access was blocked. Paste the CSV into the text box below, then tap Preview pasted CSV.'); }
  };
  const commit = async () => {
    if (!rows.length) return;
    setBusy(true);
    setMessage('');
    try {
      const mapped = rows.map(r => {
        const rawAmount = String(r.amountMinor || r.amount || '').trim();
        const amountMinor = r.amountMinor ? toMinorUnits(rawAmount, true) : toMinorUnits(rawAmount);
        return {
          title: r.title || r.name,
          counterpartyName: r.counterpartyName || r.counterparty || r.vendor,
          type: r.type || 'Other',
          amountMinor,
          currency: (r.currency || 'USD').toUpperCase(),
          expectedDate: r.expectedDate || r.expected_date,
          priority: r.priority || 'Medium',
          reference: r.reference || '',
          description: r.description || '',
        };
      });
      const r = await api.post('/api/import/commit', { rows:mapped });
      if (r.data?.ok === false && r.data?.code === 'FREE_PLAN_LIMIT') {
        setMessage(r.data.message || 'You’ve reached the 5 active recoveries included in the Free plan.');
        return;
      }
      if (r.data.errors?.length) setMessage(r.data.errors.map((x:any)=>`Row ${x.row}: ${x.message}`).join(' · '));
      else { setMessage(`${r.data.imported} recovery records imported successfully.`); setPastedCsv(''); setPreview(null); setRows([]); await onImported(); }
    } catch (e:any) { setMessage(e?.message || 'Import failed.'); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="page-head"><div><div className="eyebrow">Data intake</div><h1>Import recoveries</h1><p>Bring existing recovery records into Recovely with preview, validation and duplicate protection.</p></div></div>
      <section className="panel import-panel">
        <div className="import-drop"><Upload size={25}/><h2>Import CSV</h2><p>Upload a file or paste CSV directly. Required columns: title, counterparty, amount, currency, expected date.</p><div className="head-actions"><label className="btn primary"><Upload size={15}/> Choose CSV<input hidden type="file" accept=".csv,text/csv" onChange={e=>e.target.files?.[0] && readFile(e.target.files[0])}/></label><button type="button" className="btn secondary" onClick={() => void pasteCsv()} disabled={busy}>Paste CSV</button></div><textarea className="paste-area" value={pastedCsv} onChange={e=>setPastedCsv(e.target.value)} placeholder="Or paste CSV text here…" /><button type="button" className="btn secondary" onClick={() => void previewCsv(pastedCsv)} disabled={busy || !pastedCsv.trim()}>Preview pasted CSV</button></div>
        {busy && <div className="import-state">Processing…</div>}
        {preview && <div className="import-preview"><div className="panel-head"><div><h2>Preview</h2><span>{preview.totalRows} rows detected</span></div><button className="btn primary" onClick={commit} disabled={busy}>Confirm import</button></div><div className="table-wrap"><table><thead><tr>{preview.headers.slice(0,8).map((h:string)=><th key={h}>{h}</th>)}</tr></thead><tbody>{preview.preview.map((r:any,i:number)=><tr key={i}>{preview.headers.slice(0,8).map((h:string)=><td key={h}>{r[h]}</td>)}</tr>)}</tbody></table></div></div>}
        {message && <div className="import-message">{message}{message.includes('5 active recoveries') && <button className="btn primary" onClick={onUpgrade}>Upgrade to Pro</button>}</div>}
      </section>
    </>
  );
}

function parseCsv(csv: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (quoted) {
      if (char === '\"') {
        if (csv[i + 1] === '\"') { field += '\"'; i++; } else quoted = false;
      } else field += char;
    } else if (char === '\"' && field.length === 0) quoted = true;
    else if (char === ',') { row.push(field.trim()); field = ''; }
    else if (char === '\n') { row.push(field.trim()); if (row.some(Boolean)) rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field.');
  if (field.length || row.length) { row.push(field.trim()); if (row.some(Boolean)) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((x, i) => x.trim() || `column_${i + 1}`);
  return rows.slice(1).map(values => Object.fromEntries(headers.map((h, i) => [h, values[i] || ''])));
}

function TeamPage() {
  const [items,setItems] = useState<any[]>([]);
  const [email,setEmail] = useState('');
  const [role,setRole] = useState('Member');
  const [invite,setInvite] = useState<any>(null);
  const [message,setMessage] = useState('');
  const load = async()=>{ const r=await api.get('/api/team'); setItems(r.data.items||[]); };
  useEffect(()=>{load();},[]);
  const createInvite=async()=>{ try { const r=await api.post('/api/team/invites',{email,role}); setInvite(r.data); setMessage('Invite created. Share the code with the teammate.'); } catch(e:any){setMessage(e?.message||'Could not create invite.');} };
  const changeRole=async(id:string,next:string)=>{ try { await api.put(`/api/team/${id}`,{role:next}); await load(); } catch(e:any){setMessage(e?.message||'Could not update role.');} };
  return (
    <>
      <div className="page-head"><div><div className="eyebrow">Workspace collaboration</div><h1>Team</h1><p>Keep recovery ownership accountable with explicit workspace roles.</p></div></div>
      <div className="team-grid">
        <section className="panel form-panel"><h2>Invite teammate</h2><label>Email<input value={email} onChange={e=>setEmail(e.target.value)} placeholder="teammate@company.com"/></label><label>Role<select value={role} onChange={e=>setRole(e.target.value)}><option>Admin</option><option>Member</option><option>Viewer</option></select></label><button className="btn primary" onClick={createInvite}><UserPlus size={15}/> Create invite</button>{invite&&<div className="invite-result"><b>Invite code</b><code>{invite.code}</code><span>Expires in 7 days · {invite.email}</span></div>}{message&&<div className="form-error">{message}</div>}</section>
        <section className="panel table-panel"><div className="panel-head"><div><h2>Members</h2><span>Roles are enforced server-side.</span></div></div><div className="table-wrap"><table><thead><tr><th>User ID</th><th>Role</th><th>Created</th><th/></tr></thead><tbody>{items.map(m=><tr key={m.id}><td><b>{m.userId}</b></td><td><select className="role-select" value={m.role} disabled={m.role==='Owner'} onChange={e=>changeRole(m.id,e.target.value)}><option>Owner</option><option>Admin</option><option>Member</option><option>Viewer</option></select></td><td>{new Date(m.createdAt).toLocaleDateString()}</td><td>{m.role==='Owner'?'Owner':''}</td></tr>)}</tbody></table></div></section>
      </div>
    </>
  );
}

function InboxPage({ onOpenRecovery }: { onOpenRecovery: (r: Recovery) => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [unread, setUnread] = useState(0);
  const load = async () => { const r = await api.get('/api/notifications'); setItems(r.data.items || []); setUnread(r.data.unread || 0); };
  useEffect(() => { load(); }, []);
  const markAll = async () => { await api.post('/api/notifications/read-all', {}); await load(); };
  const open = async (item: any) => {
    if (!item.readAt) await api.post(`/api/notifications/${item.id}/read`, {});
    await load();
    if (item.recoveryId) { const r = await api.get('/api/recoveries'); const found = (r.data.items || []).find((x: Recovery) => x.id === item.recoveryId); if (found) onOpenRecovery(found); }
  };
  return (
    <>
      <div className="page-head">
        <div><div className="eyebrow">Notifications</div><h1>Inbox</h1><p>Important recovery activity, kept close to the workflow.</p></div>
        {unread > 0 && <button className="btn secondary" onClick={markAll}>Mark all read</button>}
      </div>
      <section className="panel notification-panel">
        {items.length ? items.map(item => (
          <button key={item.id} className={item.readAt ? 'notification-row read' : 'notification-row'} onClick={() => open(item)}>
            <span className="notification-icon"><Bell size={16}/></span>
            <div><b>{item.title}</b><p>{item.message}</p><small>{new Date(item.createdAt).toLocaleString()}</small></div>
            {!item.readAt && <i className="unread-dot" />}
          </button>
        )) : <div className="large-empty"><Bell size={30}/><h2>Your inbox is quiet.</h2><p>Real recovery updates and follow-up activity will appear here.</p></div>}
      </section>
    </>
  );
}
const CANONICAL_BILLING_PLANS = [
  { id: 'free', name: 'Free', amountMinor: 0, currency: 'USD', activeLimit: 5 },
  { id: 'pro', name: 'Pro', amountMinor: 900, currency: 'USD', billingAmountMinor: 1260000, billingCurrency: 'NGN', activeLimit: null },
  { id: 'business', name: 'Business', amountMinor: 2900, currency: 'USD', billingAmountMinor: 4060000, billingCurrency: 'NGN', activeLimit: null },
];

const FALLBACK_BILLING_STATE = {
  plan: 'free',
  paystackConfigured: false,
  subscription: null,
  entitlements: { paid: false, plan: 'free', unlimitedActiveRecoveries: false },
  transactions: [],
  billingCurrency: 'NGN',
  billingFxRateNgnPerUsd: 1400,
  plans: CANONICAL_BILLING_PLANS,
};

function BillingPage() {
  const [state, setState] = useState<any>(FALLBACK_BILLING_STATE);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/api/billing/status');
      const live = r.data && typeof r.data === 'object' ? r.data : {};
      const livePlans = Array.isArray(live.plans) ? live.plans : [];
      const plansById = new Map(livePlans.map((plan: any) => [String(plan?.id || ''), plan]));
      const plans = CANONICAL_BILLING_PLANS.map(canonical => ({
        ...canonical,
        ...(plansById.get(canonical.id) || {}),
        amountMinor: canonical.amountMinor,
        currency: 'USD',
        billingAmountMinor: canonical.billingAmountMinor,
        billingCurrency: canonical.billingCurrency,
      }));
      setState({ ...FALLBACK_BILLING_STATE, ...live, plans });
    } catch (e: any) {
      console.error('Billing status load failed', e);
      setState(current => current || FALLBACK_BILLING_STATE);
      setMessage('Live billing status is temporarily unavailable. The real plan prices remain visible, but checkout is disabled until Paystack status can be verified.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const params = new URLSearchParams(window.location.search);
    const reference = params.get('reference') || params.get('trxref');
    if (reference && sessionStorage.getItem(`recovely_verified_${reference}`) !== '1') {
      setBusy('verifying');
      void (async () => {
        let finalStatus = '';
        try {
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const result = await api.post('/api/billing/verify', { reference });
            if (result.data?.verified === true) {
              sessionStorage.setItem(`recovely_verified_${reference}`, '1');
              setMessage(`Payment verified by the server. ${String(result.data.plan || '').toUpperCase()} access is active now.`);
              await load();
              window.history.replaceState({}, document.title, `${window.location.pathname}#billing`);
              window.setTimeout(() => window.location.reload(), 350);
              return;
            }
            finalStatus = String(result.data?.status || 'pending').toLowerCase();
            if (!['pending','processing','ongoing','queued'].includes(finalStatus)) break;
            setMessage('Payment is still being confirmed by Paystack. Recovely has not unlocked paid access yet.');
            if (attempt < 7) await new Promise(resolve => window.setTimeout(resolve, 5000));
          }
          if (['pending','processing','ongoing','queued'].includes(finalStatus)) setMessage('Payment is still processing. Paid access will unlock only after the backend verifies a successful Paystack payment.');
          else setMessage('Payment was not completed successfully. No paid access was granted.');
          await load();
        } catch (e: any) {
          if (e?.status === 402) setMessage('Paystack reported that this payment was not successful. No paid access was granted.');
          else setMessage(e?.message || 'Payment could not be verified by the server. No paid access was granted.');
          await load();
        } finally {
          window.history.replaceState({}, document.title, `${window.location.pathname}#billing`);
          setBusy('');
        }
      })();
    }
  }, []);

  const checkout = async (plan: 'pro' | 'business') => {
    setBusy(plan);
    setMessage('');
    try {
      const callbackUrl = `${window.location.origin}${window.location.pathname}#billing`;
      const r = await api.post('/api/billing/initialize', { plan, callbackUrl });
      if (r.data?.ok === false) {
        setMessage(r.data.message || 'Paystack checkout could not be started. No billing change was made.');
        setBusy('');
        return;
      }
      if (!r.data.authorizationUrl) throw new Error('Paystack did not return a checkout URL.');
      window.location.href = r.data.authorizationUrl;
    } catch (e: any) {
      setMessage(e?.message || 'Checkout could not be started. No billing change was made.');
      setBusy('');
    }
  };

  if (loading) return <div className='panel large-empty'><Clock3 size={28}/><h2>Loading billing</h2><p>Checking the authoritative workspace billing state…</p></div>;

  const visiblePlans = CANONICAL_BILLING_PLANS.map(canonical => {
    const live = Array.isArray(state?.plans) ? state.plans.find((plan: any) => plan?.id === canonical.id) : null;
    return {
      ...canonical,
      ...(live || {}),
      amountMinor: canonical.amountMinor,
      currency: 'USD',
      billingAmountMinor: canonical.billingAmountMinor,
      billingCurrency: canonical.billingCurrency,
    };
  });
  const currentPlan = visiblePlans.find((p: any) => p.id === state?.plan) || visiblePlans[0];
  return (
    <>
      <div className='page-head'><div><div className='eyebrow'>Commercial control</div><h1>Billing</h1><p>Plans and subscription prices are shown in USD. Paystack checkout uses the server-authoritative NGN equivalent; access changes only after server-side verification.</p></div></div>
      {message && <div className='billing-message'>{message}</div>}
      <div className='billing-current panel'>
        {state?.entitlements?.paid && <div className='billing-server-badge'>Server-authoritative entitlement: {String(state.entitlements.plan || '').toUpperCase()}</div>}
        <div><span className='insight-kicker'>CURRENT PLAN</span><h2>{currentPlan?.name || state?.plan || 'Free'}</h2><p>{state?.subscription?.status === 'active' ? 'Active subscription' : state?.plan === 'free' ? 'No paid subscription is active.' : `Subscription status: ${state?.subscription?.status || 'unknown'}`}</p></div>
        <div className='billing-status'><b>{state?.subscription?.status === 'active' ? 'Active' : 'Not active'}</b><span>{state?.subscription?.subscriptionCode ? `Subscription ${state.subscription.subscriptionCode}` : 'Server verified status'}</span></div>
      </div>
      <div className='billing-plans'>
        {visiblePlans.filter((p: any) => p.id !== 'free').map((p: any) => (
          <section className={`billing-card ${state?.plan === p.id ? 'current' : ''}`} key={p.id}>
            <div className='billing-card-top'><span>{p.name}</span>{state?.plan === p.id && <b>Current</b>}</div>
            <strong>${(Number(p.amountMinor || 0) / 100).toFixed(0)}<small>/month</small></strong>
            <p>{p.id === 'pro' ? 'Unlimited recovery tracking with advanced operational controls, evidence and reporting.' : 'For larger recovery operations needing broader team and reporting capacity.'}</p>
            {p.billingAmountMinor && <small className='billing-muted'>Paystack checkout: {money(p.billingAmountMinor, p.billingCurrency || 'NGN')} monthly equivalent.</small>}
            <ul><li>Real recovery lifecycle</li><li>Evidence and follow-ups</li><li>Advanced reporting</li></ul>
            <button className='btn primary' disabled={state?.plan === p.id || !!busy} onClick={() => checkout(p.id)}>
  {busy === p.id ? 'Opening checkout…' : state?.plan === p.id ? 'Current plan' : `Choose ${p.name}`}
</button>
            {!state?.paystackConfigured && <small className='billing-muted'>Paystack backend credentials are not configured yet.</small>}
          </section>
        ))}
      </div>
      <section className='panel billing-history'>
        <div className='panel-head'><div><h2>Payment history</h2><span>Transactions recorded by Recovely</span></div></div>
        {(state?.transactions || []).length ? <div className='table-wrap'><table><thead><tr><th>Reference</th><th>Plan</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>{state.transactions.map((t: any) => <tr key={t.id || t.reference}><td><b>{t.reference}</b></td><td>{String(t.plan || '').toUpperCase()}</td><td>{money(t.amountMinor || 0, t.currency || 'USD')}</td><td><Status status={t.status === 'success' ? 'Recovered' : ['initialized','pending','processing','ongoing','queued'].includes(String(t.status)) ? 'Preparing' : 'Disputed'} /></td><td>{new Date(t.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div> : <div className='billing-empty'>No payment transactions have been recorded for this workspace.</div>}
      </section>
    </>
  );
}

function SettingsPage({
  workspace,
  refresh,
  onSignOut,
}: {
  workspace: any;
  refresh: () => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const [name, setName] = useState(workspace?.name || '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const save = async () => {
    setSaving(true);
    setMessage('');
    try {
      await api.put('/api/workspace', { name });
      await refresh();
      setMessage('Workspace settings saved.');
    } catch (e: any) {
      setMessage(e?.message || 'Workspace settings could not be saved.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Workspace control</div>
          <h1>Settings</h1>
          <p>
            Manage workspace identity, currency and notification preferences.
          </p>
        </div>
      </div>
      <section className="settings-grid">
        <div className="panel form-panel">
          <h2>Workspace</h2>
          <label>
            Workspace name
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={80}
            />
          </label>
          <label>
            Primary reporting currency
            <select value={workspace?.currency || 'USD'} disabled>
              <option>{workspace?.currency || 'USD'}</option>
            </select>
            <small>
              Currency is retained per recovery. Conversion is not silently
              performed.
            </small>
          </label>
          {message && <div className="form-error">{message}</div>}
          <button className="btn primary" onClick={save} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
        <div className="panel plan-panel">
          <div className="plan-badge">CURRENT PLAN</div>
          <h2>{workspace?.plan ? `${String(workspace.plan).charAt(0).toUpperCase()}${String(workspace.plan).slice(1)}` : 'Free'}</h2>
          <p>
            {workspace?.plan === 'free' ? '5 active recoveries, core recovery lifecycle, evidence, reminders, overdue tracking and export.' : 'Paid workspace with unlimited active recovery tracking and server-verified billing entitlements.'}
          </p>
          <div className="plan-rule">
            <span>Active recoveries</span>
            <b>{workspace?.plan === 'free' ? `${workspace?.activeCount || 0} / 5` : `${workspace?.activeCount || 0} active`}</b>
          </div>
          <button className='btn secondary' onClick={() => { window.location.hash = 'billing'; }}>
            Manage billing
          </button>
          <small>
            Billing opens a server-verified Paystack checkout when the required backend configuration is present.
          </small>
        </div>
      </section>
      <section className="panel settings-account">
        <div>
          <div className="plan-badge">ACCOUNT</div>
          <h2>Sign out of Recovely</h2>
          <p>End the current authenticated session on this device.</p>
        </div>
        <button className="btn secondary" onClick={onSignOut}><LogOut size={15} /> Sign out</button>
      </section>
    </>
  );
}
function HelpPage({ onFeedback }: { onFeedback: () => void }) {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Support</div>
          <h1>Help & support</h1>
          <p>
            Recovely is designed to keep recovery work understandable and
            accountable.
          </p>
        </div>
      </div>
      <section className="faq-grid">
        <div className="faq">
          <b>What is a recovery?</b>
          <p>
            A recovery is value your business believes it is entitled to receive
            because of a transaction, discrepancy, claim, refund, credit or
            similar event.
          </p>
        </div>
        <div className="faq">
          <b>Does Recovely invent data?</b>
          <p>
            No. Empty workspaces are intentionally empty. Dashboard numbers and
            reports are calculated from persisted records.
          </p>
        </div>
        <div className="faq">
          <b>How is health determined?</b>
          <p>
            Health is deterministic: due dates, status, stalling and remaining
            value drive the operational signal. There is no hidden AI score.
          </p>
        </div>
      </section>
      <section className="panel support-contact" style={{ marginTop: 12 }}>
        <div>
          <div className="eyebrow">Need help?</div>
          <h2>Talk to the Recovely team</h2>
          <p>Use the in-app feedback form for support questions, complaints, bug reports, feature requests, or workflow needs. Your message is saved with your account so the team can review it.</p>
        </div>
        <button className="btn primary" onClick={onFeedback}>Contact support through Feedback</button>
      </section>
    </>
  );
}
function AddRecovery({
  onClose,
  onUpgrade,
  onSaved,
}: {
  onClose: () => void;
  onUpgrade: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    title: '',
    counterpartyName: '',
    type: 'Supplier Credit',
    amount: '',
    currency: 'USD',
    expectedDate: '',
    priority: 'Medium',
    description: '',
    reference: '',
  });
  const [errorMsg, setErrorMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const update = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));
  const submit = async () => {
    setErrorMsg('');
    if (
      !form.title.trim() ||
      !form.counterpartyName.trim() ||
      !form.amount ||
      !form.expectedDate
    ) {
      setErrorMsg(
        'Title, counterparty, amount and expected date are required.'
      );
      return;
    }
    const amountMinor = toMinorUnits(form.amount);
    if (amountMinor === null) {
      setErrorMsg('Enter a valid positive amount with no more than 2 decimal places.');
      return;
    }
    setSaving(true);
    try {
      const r = await api.post('/api/recoveries', {
        ...form,
        amountMinor,
      });
      if (r.data?.ok === false && r.data?.code === 'FREE_PLAN_LIMIT') {
        setErrorMsg(r.data.message || 'You’ve reached the 5 active recoveries included in the Free plan.');
        return;
      }
      await onSaved();
    } catch (e: any) {
      if (e?.status === 402) {
        try {
          const boot = await api.get('/api/bootstrap');
          const activeCount = Number(boot.data?.workspace?.activeCount) || 0;
          if (boot.data?.workspace?.plan === 'free' && activeCount >= 5) {
            setErrorMsg('You’ve reached the 5 active recoveries included in the Free plan. Upgrade to Pro to continue.');
          } else {
            setErrorMsg('The server rejected this recovery request with Payment Required (402). No recovery was created. Please retry; if it repeats, use Support / Feedback so the exact server response can be investigated.');
          }
        } catch {
          setErrorMsg('The server rejected this recovery request with Payment Required (402). No recovery was created. Please retry; if it repeats, use Support / Feedback so the exact server response can be investigated.');
        }
      } else if (e?.status === 404) {
        setErrorMsg('The recovery API returned 404. No recovery was created. Please reload once; if this repeats, the deployment is not serving the recovery endpoint correctly.');
      } else {
        setErrorMsg(e?.message || 'Could not create recovery.');
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-head">
          <div>
            <span className="eyebrow">New recovery</span>
            <h2>Add value worth recovering</h2>
          </div>
          <button className="icon-btn" onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        <div className="form-grid">
          <label className="full">
            Title
            <input
              value={form.title}
              onChange={e => update('title', e.target.value)}
              placeholder="Supplier credit for damaged goods"
            />
          </label>
          <label>
            Counterparty
            <input
              value={form.counterpartyName}
              onChange={e => update('counterpartyName', e.target.value)}
              placeholder="Company or party name"
            />
          </label>
          <label>
            Recovery type
            <select
              value={form.type}
              onChange={e => update('type', e.target.value)}
            >
              {types.map(t => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Original amount
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.amount}
              onChange={e => update('amount', e.target.value)}
              placeholder="0.00"
            />
          </label>
          <label>
            Currency
            <select
              value={form.currency}
              onChange={e => update('currency', e.target.value)}
            >
              {currencies.map(c => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            Expected recovery date
            <input
              type="date"
              value={form.expectedDate}
              onChange={e => update('expectedDate', e.target.value)}
            />
          </label>
          <label>
            Priority
            <select
              value={form.priority}
              onChange={e => update('priority', e.target.value)}
            >
              <option>Low</option>
              <option>Medium</option>
              <option>High</option>
              <option>Critical</option>
            </select>
          </label>
          <label className="full">
            Reference
            <input
              value={form.reference}
              onChange={e => update('reference', e.target.value)}
              placeholder="Invoice, PO, claim or case reference"
            />
          </label>
          <label className="full">
            Description
            <textarea
              value={form.description}
              onChange={e => update('description', e.target.value)}
              placeholder="What happened and why is the business entitled to recover this value?"
            />
          </label>
        </div>
        {errorMsg && <div className="form-error">{errorMsg}</div>}
        <div className="modal-foot">
          <span>Amounts are stored as integer minor units for precision.</span>
          <div>
            <button className="btn secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={errorMsg.includes('5 active recoveries') ? onUpgrade : submit}
              disabled={saving}
            >
              {errorMsg.includes('5 active recoveries') ? 'Upgrade to Pro' : saving ? 'Saving…' : 'Create recovery'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
function RecoveryDrawer({
  recovery,
  onClose,
  onSaved,
}: {
  recovery: Recovery;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [status, setStatus] = useState(recovery.status);
  const [recovered, setRecovered] = useState(
    (recovery.recoveredMinor / 100).toFixed(2)
  );
  const [note, setNote] = useState('');
  const [events, setEvents] = useState<any[]>([]);
  const [evidence, setEvidence] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [followUps, setFollowUps] = useState<any[]>([]);
  const [followTitle, setFollowTitle] = useState('');
  const [followDue, setFollowDue] = useState('');
  useEffect(() => {
    Promise.all([api.get(`/api/recoveries/${recovery.id}/timeline`), api.get(`/api/recoveries/${recovery.id}/evidence`), api.get('/api/follow-ups')]).then(([timeline, files, follows]) => { setEvents(timeline.data.items || []); setEvidence(files.data.items || []); setFollowUps((follows.data.items || []).filter((x: any) => x.recoveryId === recovery.id)); });
  }, [recovery.id]);
  const save = async () => {
    const recoveredMinor = toMinorUnits(recovered, true);
    if (recoveredMinor === null || recoveredMinor > recovery.amountMinor) return;
    setBusy(true);
    setErrorMsg('');
    try {
      const r = await api.put(`/api/recoveries/${recovery.id}`, {
        status,
        recoveredMinor,
      });
      if (r.data?.ok === false && r.data?.code === 'FREE_PLAN_LIMIT') {
        setErrorMsg(r.data.message || 'You’ve reached the 5 active recoveries included in the Free plan. Upgrade to Pro to continue.');
        return;
      }
      await onSaved();
    } catch (error: any) {
      setErrorMsg(error?.message || 'The recovery could not be saved. No changes were made.');
    } finally {
      setBusy(false);
    }
  };
  const addNote = async () => {
    if (!note.trim()) return;
    await api.post(`/api/recoveries/${recovery.id}/notes`, { content: note });
    setNote('');
    const r = await api.get(`/api/recoveries/${recovery.id}/timeline`);
    setEvents(r.data.items || []);
  };
  const recoveredMinorForDisplay = toMinorUnits(recovered, true) ?? 0;
  const remaining = Math.max(recovery.amountMinor - recoveredMinorForDisplay, 0);
  return (
    <div className="drawer-backdrop">
      <aside className="drawer">
        <div className="drawer-head">
          <div>
            <span className="eyebrow">Recovery detail</span>
            <h2>{recovery.title}</h2>
            <p>{recovery.counterpartyName}</p>
          </div>
          <button className="icon-btn" onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        <div className="amount-hero">
          <span>Outstanding</span>
          <strong>{money(remaining, recovery.currency)}</strong>
          <div>
            <Status status={status} />
            <span>{recovery.priority} priority</span>
          </div>
        </div>
        <div className="detail-grid">
          <div>
            <span>Original</span>
            <b>{money(recovery.amountMinor, recovery.currency)}</b>
          </div>
          <div>
            <span>Recovered</span>
            <b>
              {money(recoveredMinorForDisplay, recovery.currency)}
            </b>
          </div>
          <div>
            <span>Expected</span>
            <b>{new Date(recovery.expectedDate).toLocaleDateString()}</b>
          </div>
          <div>
            <span>Type</span>
            <b>{recovery.type}</b>
          </div>
        </div>
        {errorMsg && <div className="form-error">{errorMsg}{errorMsg.includes('5 active recoveries') && <button type="button" className="btn primary" style={{ marginTop: 10 }} onClick={() => { window.location.hash = 'billing'; onClose(); }}>Upgrade to Pro</button>}</div>}
        <label>
          Status
          <select value={status} onChange={e => setStatus(e.target.value)}>
            {statuses.map(s => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Recovered amount
          <input
            type="number"
            min="0"
            max={recovery.amountMinor / 100}
            step="0.01"
            value={recovered}
            onChange={e => setRecovered(e.target.value)}
          />
        </label>
        <div className="health">
          <span>Health</span>
          <b>
            {status === 'Overdue'
              ? 'Needs attention'
              : remaining === 0
                ? 'On track'
                : 'On track'}
          </b>
          <small>
            Deterministic from status, due date and remaining value.
          </small>
        </div>
        <button className="btn primary full-btn" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save recovery'}
        </button>
        <div className="evidence-section">
          <div className="section-title"><b>Evidence</b><span>Private recovery documents and proof</span></div>
          <label className="evidence-upload"><Paperclip size={15}/> Add evidence<input hidden type="file" accept="application/pdf,image/png,image/jpeg,image/webp,text/plain,text/csv" onChange={async e=>{ const file=e.target.files?.[0]; if(!file) return; const reader=new FileReader(); reader.onload=async()=>{ const result=String(reader.result||''); const base64=result.split(',')[1] || ''; try { await api.post(`/api/recoveries/${recovery.id}/evidence/upload`,{content:base64,contentType:file.type,originalName:file.name}); const r=await api.get(`/api/recoveries/${recovery.id}/evidence`); setEvidence(r.data.items||[]); } catch(err:any) { window.alert(err?.message || 'Evidence upload failed.'); } }; reader.readAsDataURL(file); }}/> </label>
          {evidence.map(f=><div className="evidence-row" key={f.id}><Paperclip size={14}/><div><b>{f.originalName}</b><span>{Math.max(1,Math.round(f.size/1024))} KB · {new Date(f.createdAt).toLocaleDateString()}</span></div>{f.url&&<a href={f.url} target="_blank" rel="noreferrer">Open</a>}</div>)}
          {!evidence.length&&<div className="evidence-empty">No evidence attached yet.</div>}
        </div>
        <div className="followup-section">
          <div className="section-title"><b>Next actions</b><span>Follow-ups stay attached to this recovery</span></div>
          <div className="followup-form"><input value={followTitle} onChange={e=>setFollowTitle(e.target.value)} placeholder="Call supplier, send claim, request credit…"/><input type="datetime-local" value={followDue} onChange={e=>setFollowDue(e.target.value)}/><button className="btn secondary" onClick={async()=>{ if(!followTitle.trim()||!followDue) return; await api.post('/api/follow-ups',{recoveryId:recovery.id,title:followTitle,dueAt:new Date(followDue).toISOString()}); setFollowTitle(''); setFollowDue(''); const r=await api.get('/api/follow-ups'); setFollowUps((r.data.items||[]).filter((x:any)=>x.recoveryId===recovery.id)); }}>Add</button></div>
          {followUps.map(f=><div className="followup-row" key={f.id}><div><b>{f.title}</b><span>{new Date(f.dueAt).toLocaleString()}</span></div><select value={f.status} onChange={async e=>{ await api.put(`/api/follow-ups/${f.id}`,{status:e.target.value}); const r=await api.get('/api/follow-ups'); setFollowUps((r.data.items||[]).filter((x:any)=>x.recoveryId===recovery.id)); }}><option>Pending</option><option>Completed</option><option>Skipped</option><option>Cancelled</option></select></div>)}
        </div>
        <div className="timeline">
          <div className="section-title">
            <b>Timeline</b>
            <span>Immutable operational history</span>
          </div>
          {events.map((e, i) => (
            <div className="event" key={e.id || i}>
              <i />
              <div>
                <b>{e.type}</b>
                <span>
                  {e.actorName || 'Workspace user'} ·{' '}
                  {new Date(e.createdAt).toLocaleString()}
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="note-box">
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Add an internal note…"
          />
          <button className="btn secondary" onClick={addNote}>
            Add note
          </button>
        </div>
      </aside>
    </div>
  );
}

export default function RecovelyRoot() {
  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  );
}
