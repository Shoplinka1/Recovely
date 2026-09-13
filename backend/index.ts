import { router, json, error, requireAuth as sdkRequireAuth, auth, type RouterMiddleware } from '@appdeploy/sdk';
import { db, storage, secrets, invites, isInviteError } from '@appdeploy/sdk';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'NGN', 'CAD', 'AUD'];
const AUTH_HANDOFF_ORIGINS = new Set([
  'https://recovery-dyzmt8hq9-receiptguard.vercel.app',
  'https://recovery-phi-six.vercel.app',
  'https://recovery-9761o968t-receiptguard.vercel.app',
  'https://receiptguard.xyz',
  'https://www.receiptguard.xyz',
  'https://getreceiptguard.xyz',
  'https://www.getreceiptguard.xyz',
]);
const AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const AUTH_HANDOFF_TTL_MS = 2 * 60 * 1000;
const SUPABASE_URL = 'https://fyxywsocbfcnbprlknfp.supabase.co';
const SUPABASE_ISSUER = `${SUPABASE_URL}/auth/v1`;
const SUPABASE_JWKS = createRemoteJWKSet(new URL(`${SUPABASE_ISSUER}/.well-known/jwks.json`));
const hashAuthValue = (value: string) => createHash('sha256').update(value).digest('hex');

const verifySupabaseAccessToken = async (token: string) => {
  try {
    const { payload } = await jwtVerify(token, SUPABASE_JWKS, {
      issuer: SUPABASE_ISSUER,
      audience: 'authenticated',
    });
    if (typeof payload.sub !== 'string' || !payload.sub.trim()) return null;
    const metadata = payload.user_metadata && typeof payload.user_metadata === 'object'
      ? payload.user_metadata as Record<string, unknown>
      : {};
    const metadataName = typeof metadata.full_name === 'string' ? metadata.full_name.trim() : '';
    const name = metadataName || (typeof payload.email === 'string' ? payload.email.split('@')[0] : '');
    return {
      userId: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      name,
      scope: typeof payload.role === 'string' ? payload.role : 'authenticated',
    };
  } catch {
    return null;
  }
};
const STATUSES = [
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
const TYPES = [
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
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const allowedTransitions: Record<string, string[]> = {
  Identified: ['Preparing', 'Cancelled', 'Paused'],
  Preparing: ['Submitted', 'Cancelled', 'Paused'],
  Submitted: ['Acknowledged', 'Under Review', 'Disputed', 'Paused'],
  Acknowledged: ['Under Review', 'Promised', 'Disputed', 'Paused'],
  'Under Review': ['Promised', 'Due', 'Disputed', 'Paused'],
  Promised: ['Due', 'Partially Recovered', 'Recovered', 'Disputed', 'Paused'],
  Due: ['Overdue', 'Partially Recovered', 'Recovered', 'Disputed', 'Paused'],
  Overdue: [
    'Partially Recovered',
    'Recovered',
    'Disputed',
    'Written Off',
    'Paused',
  ],
  'Partially Recovered': ['Due', 'Overdue', 'Recovered', 'Disputed', 'Paused'],
  Recovered: ['Verified', 'Closed', 'Partially Recovered'],
  Verified: ['Closed', 'Recovered'],
  Closed: ['Recovered', 'Verified'],
  Paused: ['Preparing', 'Submitted', 'Due', 'Cancelled'],
  Disputed: ['Under Review', 'Due', 'Cancelled', 'Written Off'],
  Cancelled: ['Identified'],
  'Written Off': ['Identified'],
};
const table = (kind: string, workspaceId: string) => `${kind}:${workspaceId}`;
const now = () => new Date().toISOString();
const parseBody = (body: unknown) =>
  body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
const requireString = (v: unknown, name: string, max = 500) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw new Error(`${name} is required`);
  return v.trim();
};
const requireMoney = (v: unknown) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0)
    throw new Error('Amount must be a positive integer minor-unit value');
  return v;
};
const workspaceFor = async (userId: string) => {
  const { items } = await db.list<any>(table('workspacesByUser', userId), {
    limit: 1,
  });
  if (items[0]) {
    let workspace = items[0];
    if (workspace.ownerId && workspace.ownerId !== userId) {
      const { items: ownerWorkspaces } = await db.list<any>(table('workspacesByUser', workspace.ownerId), { limit: 1 });
      if (ownerWorkspaces[0]) workspace = ownerWorkspaces[0];
    }
    const { items: members } = await db.list<any>(table('members', workspace.workspaceId), { limit: 100 });
    if (!members.some(member => member.userId === userId)) {
      await db.add(table('members', workspace.workspaceId), [{ userId, role: 'Owner', createdAt: now() }]);
    }
    return workspace;
  }
  const workspaceId = `${userId}-workspace`;
  const createdAt = now();
  const record = {
    workspaceId,
    name: 'My recovery workspace',
    currency: 'USD',
    plan: 'free',
    createdAt,
    updatedAt: createdAt,
    ownerId: userId,
  };
  const [id] = await db.add(table('workspacesByUser', userId), [record]);
  if (!id) throw new Error('Could not initialize workspace');
  await db.add(table('members', workspaceId), [
    { userId, role: 'Owner', createdAt },
  ]);
  return { id, ...record };
};
const indexSubscription = async (subscriptionCode: string, workspaceId: string, ownerId: string) => {
  if (!subscriptionCode) return;
  const indexTable = `billingSubscriptionByCode:${encodeURIComponent(subscriptionCode)}`;
  const { items: existing } = await db.list<any>(indexTable, { limit: 1 });
  if (existing[0]) return;
  await db.add(indexTable, [{ subscriptionCode, workspaceId, ownerId, createdAt: now() }]);
};

const BILLING_USD_NGN_RATE = 1400;
const billingAmountNgnMinor = (plan: 'pro' | 'business') => Math.round((plan === 'pro' ? 9 : 29) * BILLING_USD_NGN_RATE * 100);

type PaystackResult = { response: Response; data: any };
const paystackRequest = async (secret: string, url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<PaystackResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(`Paystack request timed out after ${timeoutMs / 1000}s.`);
    throw new Error(`Could not reach Paystack: ${typeof e?.message === 'string' ? e.message : 'network error'}`);
  } finally {
    clearTimeout(timeout);
  }
};

const paystackFailure = (stage: string, response: Response | null, data: any) => {
  const parts = [`Paystack ${stage} failed`];
  if (response) parts.push(`HTTP ${response.status}`);
  if (typeof data?.message === 'string' && data.message.trim()) parts.push(data.message.trim());
  if (typeof data?.code === 'string' && data.code.trim()) parts.push(`Code: ${data.code.trim()}`);
  if (typeof data?.type === 'string' && data.type.trim()) parts.push(`Type: ${data.type.trim()}`);
  const nextStep = data?.meta?.nextStep || data?.meta?.next_step;
  if (typeof nextStep === 'string' && nextStep.trim()) parts.push(nextStep.trim());
  return new Error(parts.join(' — ').slice(0, 420));
};

const validatePaystackSecret = async (secret: string) => {
  const { response, data } = await paystackRequest(secret, 'https://api.paystack.co/plan?perPage=1', {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!response.ok || !data.status) throw paystackFailure('authentication check', response, data);
};

const ensurePaystackPlan = async (secret: string, plan: 'pro' | 'business') => {
  const amount = billingAmountNgnMinor(plan);
  const name = plan === 'pro' ? 'Recovely Pro NGN' : 'Recovely Business NGN';
  const cacheTable = `billingPlanByName:${plan}`;
  const { items: cached } = await db.list<any>(cacheTable, { limit: 1 });
  if (cached[0]?.planCode) {
    const { response, data } = await paystackRequest(secret, `https://api.paystack.co/plan/${encodeURIComponent(String(cached[0].planCode))}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const remote = data?.data;
    if (response.ok && data?.status && remote?.plan_code && Number(remote.amount) === amount && String(remote.interval) === 'monthly' && String(remote.currency || '').toUpperCase() === 'NGN') {
      return String(remote.plan_code);
    }
  }
  const { response: listResponse, data: listData } = await paystackRequest(secret, `https://api.paystack.co/plan?perPage=100&amount=${amount}&interval=monthly`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!listResponse.ok || !listData?.status) throw paystackFailure('plan lookup', listResponse, listData);
  const plans = Array.isArray(listData.data) ? listData.data : (Array.isArray(listData.data?.data) ? listData.data.data : []);
  const existing = plans.find((p: any) => String(p.name) === name && Number(p.amount) === amount && String(p.interval) === 'monthly' && String(p.currency || '').toUpperCase() === 'NGN');
  if (existing?.plan_code) {
    const planCode = String(existing.plan_code);
    await db.add(cacheTable, [{ plan, planCode, amountMinor: amount, currency: 'NGN', interval: 'monthly', updatedAt: now() }]);
    return planCode;
  }
  const { response: createResponse, data: createData } = await paystackRequest(secret, 'https://api.paystack.co/plan', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, amount, interval: 'monthly', currency: 'NGN', send_invoices: true }),
  });
  if (!createResponse.ok || !createData?.status || !createData.data?.plan_code) throw paystackFailure('plan creation', createResponse, createData);
  const planCode = String(createData.data.plan_code);
  await db.add(cacheTable, [{ plan, planCode, amountMinor: amount, currency: 'NGN', interval: 'monthly', createdAt: now() }]);
  return planCode;
};

const reconcilePaystackSubscription = async (secret: string, ws: any, subscription: any) => {
  if (!subscription?.subscriptionCode) return { ws, subscription };
  const response = await fetch(`https://api.paystack.co/subscription/${encodeURIComponent(subscription.subscriptionCode)}`, { headers: { Authorization: `Bearer ${secret}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.status || !data.data) return { ws, subscription };
  const remote = data.data;
  const remoteStatus = String(remote.status || '').toLowerCase();
  if (remoteStatus === 'complete' || remoteStatus === 'completed' || remoteStatus === 'cancelled') {
    const nextSubscription = { ...subscription, status:'expired', updatedAt:now(), expiredAt:subscription.expiredAt || now() };
    await db.update(table('subscriptions', ws.workspaceId), [{ id:subscription.id, record:nextSubscription }]);
    const nextWs = { ...ws, plan:'free', updatedAt:now() };
    await db.update(table('workspacesByUser', ws.ownerId), [{ id:ws.id, record:nextWs }]);
    return { ws:nextWs, subscription:nextSubscription };
  }
  if (remoteStatus === 'non-renewing') {
    const nextSubscription = { ...subscription, status:'active_nonrenewing', updatedAt:now() };
    await db.update(table('subscriptions', ws.workspaceId), [{ id:subscription.id, record:nextSubscription }]);
    return { ws, subscription:nextSubscription };
  }
  if (remoteStatus === 'active' || remoteStatus === 'attention') {
    const nextSubscription = { ...subscription, status:remoteStatus === 'active' ? 'active' : 'payment_failed', updatedAt:now() };
    await db.update(table('subscriptions', ws.workspaceId), [{ id:subscription.id, record:nextSubscription }]);
    return { ws, subscription:nextSubscription };
  }
  return { ws, subscription };
};

const parseCookie = (headers: Record<string, unknown>, name: string) => {
  const raw = Object.entries(headers).find(([key]) => key.toLowerCase() === 'cookie')?.[1];
  if (typeof raw !== 'string') return '';
  const prefix = `${name}=`;
  const part = raw.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : '';
};

const requireAuth = (): RouterMiddleware => async ctx => {
  const headers = ctx.event?.headers || {};
  const cookieSession = parseCookie(headers, 'recovely_session');
  const customSession = cookieSession || (Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-recovely-session')?.[1] as string | undefined) || '';
  if (typeof customSession === 'string' && customSession.trim()) {
    const sessionHash = hashAuthValue(customSession.trim());
    const { items } = await db.list<any>(`authSession:${sessionHash}`, { limit: 1 });
    const session = items[0];
    if (session && session.expiresAt > Date.now() && session.user?.userId) {
      ctx.user = session.user;
      return;
    }
  }

  const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
  if (typeof authorization === 'string') {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      const supabaseUser = await verifySupabaseAccessToken(match[1].trim());
      if (supabaseUser) {
        ctx.user = supabaseUser;
        return;
      }
    }
  }

  const user = await auth.getUser(ctx.event);
  if (!user) return error('Unauthorized', 401);
  ctx.user = user;
};

const memberRole = async (workspaceId: string, userId: string) => {
  const { items } = await db.list<any>(table('members', workspaceId), {
    limit: 50,
  });
  return items.find(x => x.userId === userId)?.role || null;
};
const baseHealth = (r: any) => {
  const remaining = Math.max((r.amountMinor || 0) - (r.recoveredMinor || 0), 0);
  const due = new Date(r.expectedDate).getTime();
  const today = Date.now();
  if (
    ['Recovered', 'Verified', 'Closed', 'Cancelled', 'Written Off'].includes(
      r.status
    )
  )
    return 'On track';
  if (r.status === 'Overdue' || due < today) return 'Needs attention';
  if (due - today < 3 * 86400000 || r.status === 'Partially Recovered')
    return 'At risk';
  return 'On track';
};
const event = async (
  workspaceId: string,
  recoveryId: string,
  userId: string,
  type: string,
  metadata: Record<string, unknown> = {}
) => {
  await db.add(table('events', workspaceId), [
    { recoveryId, actorId: userId, type, metadata, createdAt: now() },
  ]);
};
const notify = async (workspaceId: string, userId: string, kind: string, title: string, message: string, recoveryId?: string) => {
  const { items } = await db.list<any>(table('notifications', workspaceId), { limit: 100 });
  const duplicate = items.find(n => n.userId === userId && n.kind === kind && n.recoveryId === recoveryId && n.message === message);
  if (duplicate) return duplicate.id;
  const [id] = await db.add(table('notifications', workspaceId), [{ userId, kind, title, message, recoveryId: recoveryId || null, readAt: null, createdAt: now() }]);
  return id;
};

const refreshOperationalNotifications = async (workspaceId: string, userId: string) => {
  const [{ items: recoveries }, { items: followUps }] = await Promise.all([
    db.list<any>(table('recoveries', workspaceId), { limit: 100 }),
    db.list<any>(table('followUps', workspaceId), { limit: 100 }),
  ]);
  const current = Date.now();
  const soon = current + 7 * 86400000;
  for (const recovery of recoveries) {
    if (['Closed', 'Cancelled', 'Recovered', 'Verified', 'Written Off'].includes(recovery.status)) continue;
    const due = new Date(recovery.expectedDate).getTime();
    if (!Number.isFinite(due)) continue;
    if (due < current) {
      await notify(workspaceId, userId, 'recovery_overdue', 'Recovery overdue', `${recovery.title} is overdue and still has value outstanding.`, recovery.id);
    } else if (due <= soon) {
      await notify(workspaceId, userId, 'recovery_due_soon', 'Recovery due soon', `${recovery.title} is due within the next 7 days.`, recovery.id);
    }
  }
  for (const followUp of followUps) {
    if (followUp.userId && followUp.userId !== userId) continue;
    if (followUp.status !== 'Pending') continue;
    const due = new Date(followUp.dueAt).getTime();
    if (!Number.isFinite(due) || due > current) continue;
    await notify(workspaceId, userId, 'follow_up_due', 'Follow-up due', `${followUp.title} is due and needs attention.`, followUp.recoveryId);
  }
};

const parseCsv = (input: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ',') {
      row.push(field.trim());
      field = '';
    } else if (char === '\n') {
      row.push(field.trim());
      if (row.some(value => value.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field');
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    if (row.some(value => value.length > 0)) rows.push(row);
  }
  return rows;
};

const csvObjects = (input: string) => {
  const rows = parseCsv(input);
  if (!rows.length) return { headers: [], records: [] as Record<string, string>[] };
  const headers = rows[0].map((header, index) => header.trim() || `column_${index + 1}`);
  const records = rows.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
  return { headers, records };
};

export const handler = router({
  'GET /api/_healthcheck': [
    async () => json({ ok: true, message: 'Success', service: 'recovely', build: 'production', billingPrices: { proUsdMinor: 900, businessUsdMinor: 2900 }, freeActiveRecoveryLimit: 5 }),
  ],
  'POST /api/feedback': [
    requireAuth(),
    async ctx => {
      const body = parseBody(ctx.body);
      const category = requireString(body.category, 'Feedback category', 80);
      const message = requireString(body.message, 'Feedback message', 5000);
      const requestedFeature = typeof body.requestedFeature === 'string' ? body.requestedFeature.trim().slice(0, 2000) : '';
      const ws = await workspaceFor(ctx.user!.userId);
      const createdAt = now();
      const [id] = await db.add(`feedback:${ws.workspaceId}`, [{ workspaceId: ws.workspaceId, userId: ctx.user!.userId, email: ctx.user!.email || '', name: ctx.user!.name || '', category, requestedFeature, message, status: 'new', createdAt }]);
      if (!id) return error('Could not save feedback', 500);
      return json({ id, createdAt });
    },
  ],
  'GET /api/feedback': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const role = await memberRole(ws.workspaceId, ctx.user!.userId);
      if (!['Owner', 'Admin'].includes(role || '')) return error('Only owners and admins can review workspace feedback', 403);
      const { items } = await db.list<any>(`feedback:${ws.workspaceId}`, { limit: 100 });
      return json({ items: items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
    },
  ],
  'POST /api/auth/session': [
    sdkRequireAuth(),
    async ctx => {
      const body = parseBody(ctx.body);
      const origin = typeof body.origin === 'string' ? body.origin.trim() : '';
      if (!AUTH_HANDOFF_ORIGINS.has(origin)) return error('Authentication callback origin is not authorized', 403);
      const sessionId = randomBytes(32).toString('hex');
      const sessionHash = hashAuthValue(sessionId);
      const handoffCode = randomBytes(32).toString('hex');
      const handoffHash = hashAuthValue(handoffCode);
      const createdAt = Date.now();
      const user = { userId: ctx.user!.userId, email: ctx.user!.email, name: ctx.user!.name, scope: ctx.user!.scope };
      const [sessionRecordId] = await db.add(`authSession:${sessionHash}`, [{ user, origin, createdAt, expiresAt: createdAt + AUTH_SESSION_TTL_MS }]);
      if (!sessionRecordId) return error('Could not create authentication session', 500);
      const [handoffRecordId] = await db.add(`authHandoff:${handoffHash}`, [{ handoffHash, sessionId, origin, createdAt, expiresAt: createdAt + AUTH_HANDOFF_TTL_MS }]);
      if (!handoffRecordId) {
        await db.delete(`authSession:${sessionHash}`, [sessionRecordId]);
        return error('Could not create authentication handoff', 500);
      }
      return json({ code: handoffCode, user, expiresIn: Math.floor(AUTH_HANDOFF_TTL_MS / 1000) });
    },
  ],
  'POST /api/auth/redeem': [
    async ctx => {
      const body = parseBody(ctx.body);
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      const origin = typeof body.origin === 'string' ? body.origin.trim() : '';
      if (!code || !AUTH_HANDOFF_ORIGINS.has(origin)) return error('Invalid authentication handoff', 400);
      const handoffHash = hashAuthValue(code);
      const { items } = await db.list<any>(`authHandoff:${handoffHash}`, { limit: 1 });
      const handoff = items.find(item => item.handoffHash === handoffHash && item.origin === origin);
      if (!handoff) return error('Authentication handoff is invalid or has already been used', 401);
      if (!Number.isFinite(handoff.expiresAt) || handoff.expiresAt < Date.now()) {
        await db.delete(`authHandoff:${handoffHash}`, [handoff.id]);
        return error('Authentication handoff expired', 401);
      }
      const sessionHash = hashAuthValue(String(handoff.sessionId || ''));
      const { items: sessions } = await db.list<any>(`authSession:${sessionHash}`, { limit: 1 });
      const session = sessions[0];
      await db.delete(`authHandoff:${handoffHash}`, [handoff.id]);
      if (!session || session.expiresAt < Date.now()) {
        if (session?.id) await db.delete(`authSession:${sessionHash}`, [session.id]);
        return error('Authentication session expired', 401);
      }
      return json({ sessionId: handoff.sessionId, user: session.user, expiresIn: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)) });
    },
  ],
  'POST /api/auth/supabase-session': [
    async ctx => {
      const body = parseBody(ctx.body);
      const accessToken = typeof body.accessToken === 'string' ? body.accessToken.trim() : '';
      if (!accessToken) return error('Supabase access token is required', 400);
      const user = await verifySupabaseAccessToken(accessToken);
      if (!user) return error('Supabase session is invalid or expired', 401);
      const sessionId = randomBytes(32).toString('hex');
      const sessionHash = hashAuthValue(sessionId);
      const createdAt = Date.now();
      const [sessionRecordId] = await db.add(`authSession:${sessionHash}`, [{ user, createdAt, expiresAt: createdAt + AUTH_SESSION_TTL_MS }]);
      if (!sessionRecordId) return error('Could not establish authenticated workspace session', 500);
      const response = json({ ok: true, user, expiresIn: Math.floor(AUTH_SESSION_TTL_MS / 1000) });
      response.headers['Set-Cookie'] = `recovely_session=${encodeURIComponent(sessionId)}; Path=/; Max-Age=${Math.floor(AUTH_SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`;
      return response;
    },
  ],
  'POST /api/auth/supabase-session/logout': [
    async ctx => {
      const headers = ctx.event?.headers || {};
      const sessionId = parseCookie(headers, 'recovely_session');
      if (sessionId) {
        const sessionHash = hashAuthValue(sessionId);
        const { items } = await db.list<any>(`authSession:${sessionHash}`, { limit: 1 });
        if (items[0]?.id) await db.delete(`authSession:${sessionHash}`, [items[0].id]);
      }
      const response = json({ ok: true });
      response.headers['Set-Cookie'] = 'recovely_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
      return response;
    },
  ],
  'GET /api/bootstrap': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      await refreshOperationalNotifications(ws.workspaceId, ctx.user!.userId);
      const role = await memberRole(ws.workspaceId, ctx.user!.userId);
      const { items } = await db.list<any>(
        table('recoveries', ws.workspaceId),
        { limit: 100 }
      );
      const active = items.filter(
        r => !['Closed', 'Cancelled', 'Written Off'].includes(r.status)
      ).length;
      return json({
        user: {
          userId: ctx.user!.userId,
          email: ctx.user!.email,
          name: ctx.user!.name,
        },
        workspace: { ...ws, role, activeCount: active },
      });
    },
  ],
  'PUT /api/workspace': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const role = await memberRole(ws.workspaceId, ctx.user!.userId);
      if (!['Owner', 'Admin'].includes(role || '')) return error('Only owners and admins can rename the workspace', 403);
      const body = parseBody(ctx.body);
      const name = requireString(body.name, 'Workspace name', 80);
      const updated = { ...ws, name, updatedAt: now() };
      const ok = await db.update(table('workspacesByUser', ctx.user!.userId), [
        { id: ws.id, record: updated },
      ]);
      if (!ok[0]) return error('Could not update workspace', 500);
      return json({ workspace: updated });
    },
  ],
  'GET /api/dashboard': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      await refreshOperationalNotifications(ws.workspaceId, ctx.user!.userId);
      const { items } = await db.list<any>(
        table('recoveries', ws.workspaceId),
        { limit: 100 }
      );
      const currencyTotals = new Map<string, { recoverable: number; recovered: number; outstanding: number; overdue: number }>();
      for (const r of items) {
        const currency = String(r.currency || ws.currency || 'USD').toUpperCase();
        const current = currencyTotals.get(currency) || { recoverable: 0, recovered: 0, outstanding: 0, overdue: 0 };
        current.recoverable += Number(r.amountMinor) || 0;
        current.recovered += Number(r.recoveredMinor) || 0;
        current.outstanding += Math.max((Number(r.amountMinor) || 0) - (Number(r.recoveredMinor) || 0), 0);
        if (baseHealth(r) === 'Needs attention') current.overdue += Math.max((Number(r.amountMinor) || 0) - (Number(r.recoveredMinor) || 0), 0);
        currencyTotals.set(currency, current);
      }
      const currencyEntries = [...currencyTotals.entries()];
      const mixedCurrency = currencyEntries.length > 1;
      const singleCurrencyTotals = currencyEntries[0]?.[1] || { recoverable: 0, recovered: 0, outstanding: 0, overdue: 0 };
      const recoverable = mixedCurrency ? 0 : singleCurrencyTotals.recoverable;
      const recovered = mixedCurrency ? 0 : singleCurrencyTotals.recovered;
      const outstanding = mixedCurrency ? 0 : singleCurrencyTotals.outstanding;
      const overdue = mixedCurrency ? 0 : singleCurrencyTotals.overdue;
      const attention = items
        .filter(r => baseHealth(r) !== 'On track')
        .sort(
          (a, b) =>
            new Date(a.expectedDate).getTime() -
            new Date(b.expectedDate).getTime()
        )
        .map(r => ({ ...r, health: baseHealth(r) }));
      const dueSoon = items.filter(r => {
        const d = new Date(r.expectedDate).getTime() - Date.now();
        return (
          d >= 0 &&
          d < 7 * 86400000 &&
          !['Closed', 'Cancelled', 'Recovered', 'Verified'].includes(r.status)
        );
      }).length;
      return json({
        totals: {
          recoverable,
          outstanding,
          overdue,
          recovered,
          recoveryRate: mixedCurrency ? 0 : recoverable ? (recovered / recoverable) * 100 : 0,
        },
        counts: {
          total: items.length,
          overdue: items.filter(r => r.status === 'Overdue' || (baseHealth(r) === 'Needs attention' && new Date(r.expectedDate).getTime() < Date.now())).length,
          dueSoon,
          partial: items.filter(r => r.status === 'Partially Recovered').length,
        },
        recent: items
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 10),
        attention: attention.slice(0, 20),
        currency: mixedCurrency ? 'MIXED' : (currencyEntries[0]?.[0] || ws.currency),
        mixedCurrency,
        currencyTotals: Object.fromEntries(currencyEntries),
      });
    },
  ],
  'GET /api/recoveries': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const { items } = await db.list<any>(
        table('recoveries', ws.workspaceId),
        { limit: 100 }
      );
      return json({ items: items.map(r => ({ ...r, health: baseHealth(r) })) });
    },
  ],
  'POST /api/recoveries': [
    requireAuth(),
    async ctx => {
      try {
        const ws = await workspaceFor(ctx.user!.userId);
        const role = await memberRole(ws.workspaceId, ctx.user!.userId);
        if (!['Owner', 'Admin', 'Member'].includes(role || ''))
          return error('You do not have permission to create recoveries', 403);
        const body = parseBody(ctx.body);
        const { items } = await db.list<any>(
          table('recoveries', ws.workspaceId),
          { limit: 100 }
        );
        const active = items.filter(
          r => !['Closed', 'Cancelled', 'Written Off'].includes(r.status)
        ).length;
        if (ws.plan === 'free' && active >= 5)
          return json({
            ok: false,
            code: 'FREE_PLAN_LIMIT',
            message: 'You’ve reached the 5 active recoveries included in the Free plan. Upgrade to Pro to continue.'
          });
        const amountMinor = requireMoney(body.amountMinor);
        const currency = requireString(
          body.currency,
          'Currency',
          3
        ).toUpperCase();
        if (!CURRENCIES.includes(currency))
          return error('Unsupported currency', 400);
        const type = requireString(body.type, 'Recovery type', 80);
        if (!TYPES.includes(type))
          return error('Unsupported recovery type', 400);
        const expectedDate = requireString(
          body.expectedDate,
          'Expected date',
          30
        );
        const parsedDate = new Date(expectedDate);
        if (Number.isNaN(parsedDate.getTime()))
          return error('Invalid expected date', 400);
        const title = requireString(body.title, 'Title', 160);
        const counterpartyName = requireString(
          body.counterpartyName,
          'Counterparty',
          160
        );
        const priority =
          typeof body.priority === 'string' &&
          PRIORITIES.includes(body.priority)
            ? body.priority
            : 'Medium';
        const createdAt = now();
        const record = {
          workspaceId: ws.workspaceId,
          title,
          counterpartyName,
          type,
          amountMinor,
          recoveredMinor: 0,
          currency,
          expectedDate,
          status: 'Identified',
          priority,
          ownerId: ctx.user!.userId,
          description:
            typeof body.description === 'string'
              ? body.description.slice(0, 5000)
              : '',
          reference:
            typeof body.reference === 'string'
              ? body.reference.slice(0, 180)
              : '',
          createdAt,
          updatedAt: createdAt,
        };
        const [id] = await db.add(table('recoveries', ws.workspaceId), [
          record,
        ]);
        if (!id) return error('Could not create recovery', 500);
        await event(ws.workspaceId, id, ctx.user!.userId, 'Recovery created');
        await notify(ws.workspaceId, ctx.user!.userId, 'recovery_created', 'Recovery added', `${title} is now being tracked.`, id);
        return json({ id, ...record });
      } catch (e: any) {
        return error(e?.message || 'Invalid recovery', 400);
      }
    },
  ],
  'PUT /api/recoveries/:id': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const role = await memberRole(ws.workspaceId, ctx.user!.userId);
      if (!['Owner', 'Admin', 'Member'].includes(role || ''))
        return error('You do not have permission to edit recoveries', 403);
      const [existing] = await db.get<any>(
        table('recoveries', ws.workspaceId),
        [ctx.params.id]
      );
      if (!existing) return error('Recovery not found', 404);
      const body = parseBody(ctx.body);
      const nextStatus =
        typeof body.status === 'string' ? body.status : existing.status;
      if (!STATUSES.includes(nextStatus)) return error('Invalid status', 400);
      if (
        nextStatus !== existing.status &&
        !(allowedTransitions[existing.status] || []).includes(nextStatus)
      )
        return error(
          `Invalid transition from ${existing.status} to ${nextStatus}`,
          409
        );
      const nextRecovered =
        body.recoveredMinor === undefined
          ? existing.recoveredMinor
          : body.recoveredMinor;
      if (
        !Number.isInteger(nextRecovered) ||
        nextRecovered < 0 ||
        nextRecovered > existing.amountMinor
      )
        return error(
          'Recovered amount must be between 0 and original amount',
          400
        );
      let normalizedStatus = nextStatus;
      if (nextRecovered === existing.amountMinor)
        normalizedStatus = 'Recovered';
      else if (nextRecovered > 0 && nextStatus === 'Identified')
        normalizedStatus = 'Partially Recovered';
      const existingIsInactive = ['Closed', 'Cancelled', 'Written Off'].includes(existing.status);
      const nextIsActive = !['Closed', 'Cancelled', 'Written Off'].includes(normalizedStatus);
      if (ws.plan === 'free' && existingIsInactive && nextIsActive) {
        const { items } = await db.list<any>(table('recoveries', ws.workspaceId), { limit: 100 });
        const active = items.filter(r => !['Closed', 'Cancelled', 'Written Off'].includes(r.status)).length;
        if (active >= 5) {
          return json({
            ok: false,
            code: 'FREE_PLAN_LIMIT',
            message: 'You’ve reached the 5 active recoveries included in the Free plan. Upgrade to Pro to reopen this recovery.',
          });
        }
      }
      const updated = {
        ...existing,
        status: normalizedStatus,
        recoveredMinor: nextRecovered,
        updatedAt: now(),
      };
      const ok = await db.update(table('recoveries', ws.workspaceId), [
        { id: ctx.params.id, record: updated },
      ]);
      if (!ok[0]) return error('Could not update recovery', 500);
      if (existing.status !== updated.status)
        await event(
          ws.workspaceId,
          ctx.params.id,
          ctx.user!.userId,
          'Status changed',
          { from: existing.status, to: updated.status }
        );
      if (existing.recoveredMinor !== updated.recoveredMinor)
        await event(
          ws.workspaceId,
          ctx.params.id,
          ctx.user!.userId,
          'Amount recovered',
          { from: existing.recoveredMinor, to: updated.recoveredMinor }
        );
      if (existing.status !== updated.status)
        await notify(ws.workspaceId, ctx.user!.userId, 'status_update', 'Recovery status updated', `${updated.title} moved to ${updated.status}.`, ctx.params.id);
      if (existing.recoveredMinor !== updated.recoveredMinor)
        await notify(ws.workspaceId, ctx.user!.userId, 'recovery_update', 'Recovery amount updated', `${updated.title} now has ${updated.recoveredMinor} minor units recovered.`, ctx.params.id);
      return json(updated);
    },
  ],
  'GET /api/recoveries/:id/timeline': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const [recovery] = await db.get<any>(
        table('recoveries', ws.workspaceId),
        [ctx.params.id]
      );
      if (!recovery) return error('Recovery not found', 404);
      const { items } = await db.list<any>(table('events', ws.workspaceId), {
        limit: 100,
      });
      const notes = await db.list<any>(table('notes', ws.workspaceId), {
        limit: 100,
      });
      const merged: Array<{
        id: string;
        recoveryId: string;
        type: string;
        metadata: Record<string, unknown>;
        createdAt: string;
        actorId?: string;
      }> = [
        ...items
          .filter(x => x.recoveryId === ctx.params.id)
          .map(x => ({
            id: x.id,
            recoveryId: x.recoveryId,
            type: x.type,
            metadata: x.metadata || {},
            createdAt: String(x.createdAt),
            actorId: x.actorId,
          })),
        ...notes.items
          .filter(x => x.recoveryId === ctx.params.id)
          .map(x => ({
            id: x.id,
            recoveryId: x.recoveryId,
            type: 'Internal note',
            metadata: { content: x.content },
            createdAt: String(x.createdAt),
            actorId: x.authorId,
          })),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json({ items: merged });
    },
  ],
  'POST /api/recoveries/:id/notes': [
    requireAuth(),
    async ctx => {
      try {
        const ws = await workspaceFor(ctx.user!.userId);
        const [r] = await db.get<any>(table('recoveries', ws.workspaceId), [ctx.params.id]);
        if (!r) return error('Recovery not found', 404);
        const body = parseBody(ctx.body);
        const content = requireString(body.content, 'Note', 4000);
        const createdAt = now();
        const [id] = await db.add(table('notes', ws.workspaceId), [{ recoveryId: r.id, authorId: ctx.user!.userId, content, createdAt }]);
        if (!id) return error('Could not add note', 500);
        await event(ws.workspaceId, r.id, ctx.user!.userId, 'Note added');
        return json({ id });
      } catch (e: any) {
        console.error('Recovery note creation failed', e);
        return error(e?.message || 'Could not add note', 400);
      }
    },
  ],
  'GET /api/counterparties': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const { items } = await db.list<any>(
        table('recoveries', ws.workspaceId),
        { limit: 100 }
      );
      const map = new Map<string, any>();
      for (const r of items) {
        const key = `${r.counterpartyName}|${r.currency}`;
        const c = map.get(key) || {
          name: r.counterpartyName,
          type: 'business',
          currency: r.currency,
          count: 0,
          outstandingMinor: 0,
          recoveredMinor: 0,
          overdue: 0,
        };
        if (!['Closed', 'Cancelled', 'Written Off'].includes(r.status)) c.count++;
        c.outstandingMinor += Math.max(r.amountMinor - r.recoveredMinor, 0);
        c.recoveredMinor += r.recoveredMinor;
        c.overdue += baseHealth(r) === 'Needs attention' ? 1 : 0;
        map.set(key, c);
      }
      return json({
        items: [...map.values()].sort(
          (a, b) => b.outstandingMinor - a.outstandingMinor
        ),
      });
    },
  ],
  'GET /api/recoveries/export': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const { items } = await db.list<any>(
        table('recoveries', ws.workspaceId),
        { limit: 100 }
      );
      const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows = [
        'title,counterparty,type,amount,currency,recovered,remaining,status,priority,expected_date,reference',
      ];
      for (const r of items)
        rows.push(
          [
            r.title,
            r.counterpartyName,
            r.type,
            (r.amountMinor / 100).toFixed(2),
            r.currency,
            (r.recoveredMinor / 100).toFixed(2),
            ((r.amountMinor - r.recoveredMinor) / 100).toFixed(2),
            r.status,
            r.priority,
            r.expectedDate,
            r.reference,
          ]
            .map(esc)
            .join(',')
        );
      return json({ csv: rows.join('\n') });
    },
  ],
  'POST /api/recoveries/:id/evidence': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const role = await memberRole(ws.workspaceId, ctx.user!.userId);
      if (!['Owner', 'Admin', 'Member'].includes(role || '')) return error('You do not have permission to upload evidence', 403);
      const [r] = await db.get<any>(table('recoveries', ws.workspaceId), [
        ctx.params.id,
      ]);
      if (!r) return error('Recovery not found', 404);
      const body = parseBody(ctx.body);
      const content = requireString(
        body.content,
        'File content',
        8 * 1024 * 1024
      );
      const contentType = requireString(body.contentType, 'Content type', 100);
      const allowed = ['application/pdf','image/png','image/jpeg','image/webp','text/plain','text/csv'];
      if (!allowed.includes(contentType)) return error('Unsupported evidence file type', 400);
      const originalName = requireString(
        body.originalName,
        'Filename',
        160
      ).replace(/[^a-zA-Z0-9._-]/g, '_');
      const safe = `evidence/${ws.workspaceId}/${r.id}/${crypto.randomUUID()}-${originalName}`;
      const ok = await storage.write([{ path: safe, content, contentType }]);
      if (!ok[0]) return error('Evidence upload failed', 500);
      const [id] = await db.add(table('evidence', ws.workspaceId), [
        {
          recoveryId: r.id,
          path: safe,
          originalName,
          contentType,
          size: content.length,
          uploadedBy: ctx.user!.userId,
          createdAt: now(),
        },
      ]);
      await event(ws.workspaceId, r.id, ctx.user!.userId, 'Evidence added', {
        name: originalName,
      });
      return json({ id });
    },
  ],
  'GET /api/notifications': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      await refreshOperationalNotifications(ws.workspaceId, ctx.user!.userId);
      const { items } = await db.list<any>(table('notifications', ws.workspaceId), { limit: 50 });
      const mine = items.filter(n => n.userId === ctx.user!.userId).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
      return json({ items: mine, unread: mine.filter(n => !n.readAt).length });
    },
  ],
  'POST /api/import/preview': [
    requireAuth(),
    async ctx => {
      try {
        const body = parseBody(ctx.body);
        const csv = requireString(body.csv, 'CSV', 2000000);
        const parsed = csvObjects(csv);
        if (!parsed.headers.length) return error('CSV is empty', 400);
        return json({
          headers: parsed.headers,
          preview: parsed.records.slice(0, 10),
          totalRows: parsed.records.length,
        });
      } catch (e: any) {
        return error(e?.message || 'Invalid CSV', 400);
      }
    },
  ],
  'POST /api/recoveries/:id/evidence/upload': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const role = await memberRole(ws.workspaceId, ctx.user!.userId);
      if (!['Owner', 'Admin', 'Member'].includes(role || '')) return error('You do not have permission to upload evidence', 403);
      const [r] = await db.get<any>(table('recoveries', ws.workspaceId), [ctx.params.id]);
      if (!r) return error('Recovery not found', 404);
      const body = parseBody(ctx.body);
      const content = requireString(body.content, 'File content', 8 * 1024 * 1024);
      const contentType = requireString(body.contentType, 'Content type', 120);
      const originalName = requireString(body.originalName, 'Filename', 160).replace(/[^a-zA-Z0-9._-]/g, '_');
      const allowed = ['application/pdf','image/png','image/jpeg','image/webp','text/plain','text/csv'];
      if (!allowed.includes(contentType)) return error('Unsupported evidence file type', 400);
      const safe = `evidence/${ws.workspaceId}/${r.id}/${crypto.randomUUID()}-${originalName}`;
      const ok = await storage.write([{ path: safe, content, contentType }]);
      if (!ok[0]) return error('Evidence upload failed', 500);
      const createdAt = now();
      const [id] = await db.add(table('evidence', ws.workspaceId), [{ recoveryId: r.id, path: safe, originalName, contentType, size: Math.floor((content.length * 3) / 4), uploadedBy: ctx.user!.userId, createdAt }]);
      if (!id) { await storage.delete([safe]); return error('Could not record evidence', 500); }
      await event(ws.workspaceId, r.id, ctx.user!.userId, 'Evidence added', { name: originalName });
      return json({ id, originalName, contentType, size: Math.floor((content.length * 3) / 4), createdAt });
    },
  ],
  'GET /api/recoveries/:id/evidence': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const [r] = await db.get<any>(table('recoveries', ws.workspaceId), [ctx.params.id]);
      if (!r) return error('Recovery not found', 404);
      const { items } = await db.list<any>(table('evidence', ws.workspaceId), { limit: 100 });
      const mine = items.filter(x => x.recoveryId === ctx.params.id).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
      const urls = mine.length ? await storage.url(mine.map(x => x.path)) : [];
      const urlMap = new Map(urls.map(x => [x.path, x.url]));
      return json({ items: mine.map(x => ({ ...x, url: urlMap.get(x.path) || null })) });
    },
  ],
  'DELETE /api/evidence/:id': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const role = await memberRole(ws.workspaceId, ctx.user!.userId);
      if (!['Owner', 'Admin', 'Member'].includes(role || '')) return error('You do not have permission to delete evidence', 403);
      const [item] = await db.get<any>(table('evidence', ws.workspaceId), [ctx.params.id]);
      if (!item) return error('Evidence not found', 404);
      const ok = await storage.delete([item.path]);
      if (!ok[0]) return error('Could not delete evidence file', 500);
      const deleted = await db.delete(table('evidence', ws.workspaceId), [ctx.params.id]);
      if (!deleted[0]) return error('Could not delete evidence record', 500);
      await event(ws.workspaceId, item.recoveryId, ctx.user!.userId, 'Evidence removed', { name: item.originalName });
      return json({ deleted: true });
    },
  ],
  'GET /api/team': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const { items } = await db.list<any>(table('members', ws.workspaceId), { limit: 100 });
      return json({ items });
    },
  ],
  'POST /api/team/invites': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const role = await memberRole(ws.workspaceId, ctx.user!.userId);
      if (!['Owner','Admin'].includes(role || '')) return error('Only owners and admins can invite teammates', 403);
      const body = parseBody(ctx.body);
      const email = requireString(body.email, 'Email', 254).toLowerCase();
      if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return error('Enter a valid email address', 400);
      const inviteRole = typeof body.role === 'string' && ['Admin','Member','Viewer'].includes(body.role) ? body.role : 'Member';
      try {
        const created = await invites.create({ resourceType: 'recovely_workspace', authMode: 'required', actor: ctx.user!, allowList: [email], expiresInSec: 7 * 86400, context: { workspaceId: ws.workspaceId, role: inviteRole } });
        await db.add(table('workspaceInvites', ws.workspaceId), [{ code: created.code, email, role: inviteRole, createdBy: ctx.user!.userId, createdAt: now() }]);
        return json({ code: created.code, email, role: inviteRole });
      } catch (e) { if (isInviteError(e)) return error(e.code, 400); throw e; }
    },
  ],
  'GET /api/invites/:code': [
    async ctx => { try { return json(await invites.resolve({ code: ctx.params.code })); } catch (e) { if (isInviteError(e)) return error(e.code, 400); throw e; } },
  ],
  'POST /api/invites/:code/join': [
    requireAuth(),
    async ctx => {
      try {
        const joined = await invites.join({ code: ctx.params.code, actor: ctx.user! });
        const context = joined.context || {};
        const workspaceId = typeof context.workspaceId === 'string' ? context.workspaceId : '';
        const invite = workspaceId ? (await db.list<any>(table('workspaceInvites', workspaceId), { limit: 100 })).items.find(x => x.code === ctx.params.code) : null;
        if (!workspaceId || !invite) return error('Invite is not linked to a workspace', 400);
        if (!await memberRole(workspaceId, ctx.user!.userId)) await db.add(table('members', workspaceId), [{ userId: ctx.user!.userId, role: invite.role, createdAt: now() }]);
        const { items: owners } = await db.list<any>(table('members', workspaceId), { limit: 100 });
        const owner = owners.find(x => x.role === 'Owner');
        if (owner?.userId) {
          const { items: existingMappings } = await db.list<any>(table('workspacesByUser', ctx.user!.userId), { limit: 100 });
          if (!existingMappings.some(x => x.workspaceId === workspaceId)) {
            await db.add(table('workspacesByUser', ctx.user!.userId), [{ workspaceId, ownerId: owner.userId, joinedAt: now() }]);
          }
        }
        return json({ joined: true, workspaceId, role: invite.role });
      } catch (e) { if (isInviteError(e)) return error(e.code, 400); throw e; }
    },
  ],
  'PUT /api/team/:id': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const actorRole = await memberRole(ws.workspaceId, ctx.user!.userId);
      if (!['Owner','Admin'].includes(actorRole || '')) return error('Only owners and admins can change roles', 403);
      const [member] = await db.get<any>(table('members', ws.workspaceId), [ctx.params.id]);
      if (!member) return error('Member not found', 404);
      const body = parseBody(ctx.body);
      const role = typeof body.role === 'string' ? body.role : '';
      if (!['Admin','Member','Viewer'].includes(role)) return error('Invalid team role', 400);
      if (member.role === 'Owner') return error('The workspace owner cannot be demoted', 409);
      const ok = await db.update(table('members', ws.workspaceId), [{ id: ctx.params.id, record: { ...member, role } }]);
      return json({ updated: Boolean(ok[0]) });
    },
  ],
  'DELETE /api/team/:id': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const actorRole = await memberRole(ws.workspaceId, ctx.user!.userId);
      if (!['Owner','Admin'].includes(actorRole || '')) return error('Only owners and admins can remove members', 403);
      const [member] = await db.get<any>(table('members', ws.workspaceId), [ctx.params.id]);
      if (!member) return error('Member not found', 404);
      if (member.role === 'Owner') return error('The workspace owner cannot be removed', 409);
      const ok = await db.delete(table('members', ws.workspaceId), [ctx.params.id]);
      return json({ removed: Boolean(ok[0]) });
    },
  ],
  'GET /api/follow-ups': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const { items } = await db.list<any>(table('followUps', ws.workspaceId), { limit: 100 });
      return json({ items: items.filter(x => !x.userId || x.userId === ctx.user!.userId).sort((a,b) => String(a.dueAt).localeCompare(String(b.dueAt))) });
    },
  ],
  'POST /api/follow-ups': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const role = await memberRole(ws.workspaceId, ctx.user!.userId);
      if (!['Owner','Admin','Member'].includes(role || '')) return error('You do not have permission to create follow-ups', 403);
      const body = parseBody(ctx.body);
      const recoveryId = requireString(body.recoveryId, 'Recovery', 100);
      const [recovery] = await db.get<any>(table('recoveries', ws.workspaceId), [recoveryId]);
      if (!recovery) return error('Recovery not found', 404);
      const title = requireString(body.title, 'Follow-up title', 180);
      const dueAt = requireString(body.dueAt, 'Due date', 40);
      if (Number.isNaN(new Date(dueAt).getTime())) return error('Invalid follow-up date', 400);
      const [id] = await db.add(table('followUps', ws.workspaceId), [{ recoveryId, title, dueAt, userId: ctx.user!.userId, status: 'Pending', notes: typeof body.notes === 'string' ? body.notes.slice(0,2000) : '', createdAt: now(), updatedAt: now() }]);
      if (!id) return error('Could not create follow-up', 500);
      await event(ws.workspaceId, recoveryId, ctx.user!.userId, 'Follow-up created', { title, dueAt });
      await notify(ws.workspaceId, ctx.user!.userId, 'follow_up_created', 'Follow-up scheduled', `${title} is scheduled for ${new Date(dueAt).toLocaleDateString()}.`, recoveryId);
      return json({ id });
    },
  ],
  'PUT /api/follow-ups/:id': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const [existing] = await db.get<any>(table('followUps', ws.workspaceId), [ctx.params.id]);
      if (!existing) return error('Follow-up not found', 404);
      if (existing.userId !== ctx.user!.userId) return error('You do not have permission to edit this follow-up', 403);
      const body = parseBody(ctx.body);
      const status = typeof body.status === 'string' ? body.status : existing.status;
      if (!['Pending','Completed','Skipped','Cancelled'].includes(status)) return error('Invalid follow-up status', 400);
      const updated = { ...existing, status, notes: typeof body.notes === 'string' ? body.notes.slice(0,2000) : existing.notes, updatedAt: now() };
      const ok = await db.update(table('followUps', ws.workspaceId), [{ id: ctx.params.id, record: updated }]);
      if (!ok[0]) return error('Could not update follow-up', 500);
      await event(ws.workspaceId, existing.recoveryId, ctx.user!.userId, 'Follow-up updated', { from: existing.status, to: status });
      if (status === 'Completed') await notify(ws.workspaceId, ctx.user!.userId, 'follow_up_completed', 'Follow-up completed', `${existing.title} was marked complete.`, existing.recoveryId);
      return json(updated);
    },
  ],
  'PATCH /api/notifications/:id/read': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const [existing] = await db.get<any>(table('notifications', ws.workspaceId), [ctx.params.id]);
      if (!existing || existing.userId !== ctx.user!.userId) return error('Notification not found', 404);
      const updated = { ...existing, readAt: now() };
      const ok = await db.update(table('notifications', ws.workspaceId), [{ id: ctx.params.id, record: updated }]);
      if (!ok[0]) return error('Could not update notification', 500);
      return json({ read: true });
    },
  ],
  'POST /api/notifications/:id/read': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const [existing] = await db.get<any>(table('notifications', ws.workspaceId), [ctx.params.id]);
      if (!existing || existing.userId !== ctx.user!.userId) return error('Notification not found', 404);
      const updated = { ...existing, readAt: now() };
      const ok = await db.update(table('notifications', ws.workspaceId), [{ id: ctx.params.id, record: updated }]);
      if (!ok[0]) return error('Could not update notification', 500);
      return json({ read: true });
    },
  ],
  'POST /api/notifications/read-all': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const { items } = await db.list<any>(table('notifications', ws.workspaceId), { limit: 100 });
      const pending = items.filter(n => n.userId === ctx.user!.userId && !n.readAt).map(n => ({ id: n.id, record: { ...n, readAt: now() } }));
      if (pending.length) await db.update(table('notifications', ws.workspaceId), pending);
      return json({ updated: pending.length });
    },
  ],
  'POST /api/import/commit': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const role = await memberRole(ws.workspaceId, ctx.user!.userId);
      if (!['Owner','Admin','Member'].includes(role || '')) return error('You do not have permission to import recoveries', 403);
      const body = parseBody(ctx.body);
      if (!Array.isArray(body.rows) || body.rows.length > 100) return error('Import must contain 1–100 mapped rows', 400);
      const existing = (await db.list<any>(table('recoveries', ws.workspaceId), { limit: 100 })).items;
      const records: Record<string, unknown>[] = [];
      const errors: Array<{ row: number; message: string }> = [];
      const seen = new Set<string>();
      for (let i=0;i<body.rows.length;i++) {
        const row = body.rows[i] as Record<string, unknown>;
        try {
          const title = requireString(row.title, 'Title', 160);
          const counterpartyName = requireString(row.counterpartyName, 'Counterparty', 160);
          const amountMinor = requireMoney(row.amountMinor);
          const currency = requireString(row.currency, 'Currency', 3).toUpperCase();
          const type = requireString(row.type, 'Recovery type', 80);
          const expectedDate = requireString(row.expectedDate, 'Expected date', 30);
          if (!CURRENCIES.includes(currency)) throw new Error('Unsupported currency');
          if (!TYPES.includes(type)) throw new Error('Unsupported recovery type');
          if (Number.isNaN(new Date(expectedDate).getTime())) throw new Error('Invalid expected date');
          const fingerprint = `${counterpartyName.toLowerCase()}|${amountMinor}|${currency}|${String(row.reference || '').toLowerCase()}|${title.toLowerCase()}`;
          if (seen.has(fingerprint) || existing.some(r => `${String(r.counterpartyName).toLowerCase()}|${r.amountMinor}|${r.currency}|${String(r.reference || '').toLowerCase()}|${String(r.title).toLowerCase()}` === fingerprint)) throw new Error('Possible duplicate recovery');
          seen.add(fingerprint);
          records.push({ workspaceId: ws.workspaceId, title, counterpartyName, type, amountMinor, recoveredMinor: 0, currency, expectedDate, status: 'Identified', priority: ['Low','Medium','High','Critical'].includes(String(row.priority)) ? String(row.priority) : 'Medium', ownerId: ctx.user!.userId, description: typeof row.description === 'string' ? row.description.slice(0,5000) : '', reference: typeof row.reference === 'string' ? row.reference.slice(0,180) : '', createdAt: now(), updatedAt: now() });
        } catch (e: any) { errors.push({ row: i + 2, message: e?.message || 'Invalid row' }); }
      }
      if (errors.length) return json({ imported: 0, errors, total: body.rows.length }, 422);
      const active = existing.filter(r => !['Closed','Cancelled','Written Off'].includes(r.status)).length;
      if (ws.plan === 'free' && active + records.length > 5) return json({
        ok: false,
        code: 'FREE_PLAN_LIMIT',
        message: 'You’ve reached the 5 active recoveries included in the Free plan. Upgrade to Pro to continue importing recoveries.'
      });
      const ids = records.length ? await db.add(table('recoveries', ws.workspaceId), records) : [];
      return json({ imported: ids.filter(Boolean).length, total: records.length, errors: [] });
    },
  ],
  'GET /api/billing/status': [
    requireAuth(),
    async ctx => {
      const ws = await workspaceFor(ctx.user!.userId);
      const names = await secrets.listSecretNames();
      const configured = names.includes('PAYSTACK_SECRET_KEY');
      const { items } = await db.list<any>(table('subscriptions', ws.workspaceId), { limit: 10 });
      let authoritativeWs = ws;
      let authoritativeSubscription = items[0] || null;
      if (configured && authoritativeSubscription?.subscriptionCode) {
        try {
          const secret = await secrets.readSecret('PAYSTACK_SECRET_KEY');
          const reconciled = await reconcilePaystackSubscription(secret, authoritativeWs, authoritativeSubscription);
          authoritativeWs = reconciled.ws;
          authoritativeSubscription = reconciled.subscription;
        } catch (e: any) {
          console.error('Paystack billing reconciliation failed', {
            userId: ctx.user!.userId,
            detail: typeof e?.message === 'string' ? e.message : 'unknown reconciliation error',
          });
        }
      }
      const { items: transactions } = await db.list<any>(table('billingTransactions', authoritativeWs.workspaceId), { limit: 50 });
      return json({ plan: authoritativeWs.plan, paystackConfigured: configured, subscription: authoritativeSubscription, entitlements: { paid: authoritativeWs.plan !== 'free', plan: authoritativeWs.plan, unlimitedActiveRecoveries: authoritativeWs.plan === 'pro' || authoritativeWs.plan === 'business' }, transactions: transactions.sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))), billingCurrency:'NGN', billingFxRateNgnPerUsd:BILLING_USD_NGN_RATE, plans: [{ id:'free', name:'Free', amountMinor:0, currency:'USD', activeLimit:5 }, { id:'pro', name:'Pro', amountMinor:900, currency:'USD', billingAmountMinor:billingAmountNgnMinor('pro'), billingCurrency:'NGN', activeLimit:null }, { id:'business', name:'Business', amountMinor:2900, currency:'USD', billingAmountMinor:billingAmountNgnMinor('business'), billingCurrency:'NGN', activeLimit:null }] });
    },
  ],
  'POST /api/billing/initialize': [
    requireAuth(),
    async ctx => {
      const rateKey = `billing-init:${ctx.user!.userId}`;
      const rateNow = Date.now();
      const prior = (globalThis as any).__recovelyBillingInitRates as Map<string, number[]> | undefined;
      const rates = prior || new Map<string, number[]>();
      (globalThis as any).__recovelyBillingInitRates = rates;
      const recent = (rates.get(rateKey) || []).filter((ts: number) => rateNow - ts < 600000);
      if (recent.length >= 5) return error('Too many checkout attempts. Please wait a few minutes and try again.', 429);
      recent.push(rateNow);
      rates.set(rateKey, recent);

      const ws = await workspaceFor(ctx.user!.userId);
      const role = await memberRole(ws.workspaceId, ctx.user!.userId);
      if (!['Owner', 'Admin'].includes(role || '')) return error('Only owners and admins can change billing', 403);
      const body = parseBody(ctx.body);
      const plan = body.plan === 'pro' || body.plan === 'business' ? String(body.plan) : '';
      if (!plan) return error('Select a valid plan', 400);
      const email = typeof ctx.user!.email === 'string' ? ctx.user!.email.trim() : '';
      if (!email) return error('Your account needs a valid email address before Paystack checkout can start.', 400);

      const names = await secrets.listSecretNames();
      if (!names.includes('PAYSTACK_SECRET_KEY')) return error('Paystack is not configured yet. Add the backend secret before starting checkout.', 503);
      const secret = await secrets.readSecret('PAYSTACK_SECRET_KEY');
      const amount = billingAmountNgnMinor(plan);

      try {
        await validatePaystackSecret(secret);
      } catch (e: any) {
        const raw = typeof e?.message === 'string' ? e.message : 'Paystack authentication failed.';
        console.error('Paystack billing authentication failure', { userId: ctx.user!.userId, detail: raw });
        return json({ ok: false, code: 'PAYSTACK_AUTH_FAILED', stage: 'authentication', message: `${raw} Check that PAYSTACK_SECRET_KEY is a valid Paystack test/live secret for this integration.`.slice(0, 480) });
      }

      let planCode = '';
      try {
        planCode = await ensurePaystackPlan(secret, plan);
      } catch (e: any) {
        const raw = typeof e?.message === 'string' ? e.message : 'Paystack could not prepare the subscription plan.';
        console.error('Paystack plan preparation failure', { userId: ctx.user!.userId, plan, detail: raw });
        return json({ ok: false, code: 'PAYSTACK_PLAN_FAILED', stage: 'plan', message: `${raw} Billing is configured for NGN; no Paystack public key is required for this redirect checkout flow.`.slice(0, 480) });
      }

      const reference = `recovely_${ws.workspaceId}_${Date.now()}_${crypto.randomUUID().slice(0,8)}`;
      const callbackUrl = typeof body.callbackUrl === 'string' && body.callbackUrl.startsWith('https://recovely-b77j28.v2.appdeploy.ai/') ? body.callbackUrl : 'https://recovely-b77j28.v2.appdeploy.ai/#billing';
      let response: Response;
      let data: any;
      try {
        const result = await paystackRequest(secret, 'https://api.paystack.co/transaction/initialize', {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, amount, currency: 'NGN', reference, plan: planCode, callback_url: callbackUrl }),
        });
        response = result.response;
        data = result.data;
      } catch (e: any) {
        const raw = typeof e?.message === 'string' ? e.message : 'Could not reach Paystack during checkout initialization.';
        console.error('Paystack transaction request failure', { userId: ctx.user!.userId, plan, detail: raw });
        return json({ ok: false, code: 'PAYSTACK_NETWORK_FAILED', stage: 'checkout_initialization', message: raw.slice(0, 480) });
      }
      if (!response.ok || !data?.status || !data.data?.authorization_url) {
        const failure = paystackFailure('checkout initialization', response, data);
        console.error('Paystack checkout initialization rejected', { userId: ctx.user!.userId, plan, detail: failure.message });
        return json({ ok: false, code: 'PAYSTACK_CHECKOUT_FAILED', stage: 'checkout_initialization', message: failure.message });
      }

      await db.add(table('billingTransactions', ws.workspaceId), [{ reference, plan, amountMinor:amount, currency:'NGN', status:'initialized', userId:ctx.user!.userId, planCode, createdAt:now() }]);
      return json({ authorizationUrl:data.data.authorization_url, reference });
    },
  ],
  'POST /api/billing/verify': [
    requireAuth(),
    async ctx => {
      const rateKey = `billing-verify:${ctx.user!.userId}`;
      const rateNow = Date.now();
      const prior = (globalThis as any).__recovelyBillingVerifyRates as Map<string, number[]> | undefined;
      const rates = prior || new Map<string, number[]>();
      (globalThis as any).__recovelyBillingVerifyRates = rates;
      const recent = (rates.get(rateKey) || []).filter((ts: number) => rateNow - ts < 600000);
      if (recent.length >= 10) return error('Too many payment verification attempts. Please wait a few minutes and try again.', 429);
      recent.push(rateNow);
      rates.set(rateKey, recent);

      const ws = await workspaceFor(ctx.user!.userId);
      const role = await memberRole(ws.workspaceId, ctx.user!.userId);
      if (!['Owner', 'Admin'].includes(role || '')) return error('Only owners and admins can change billing', 403);
      const body = parseBody(ctx.body);
      const reference = requireString(body.reference, 'Transaction reference', 180);
      const { items } = await db.list<any>(table('billingTransactions', ws.workspaceId), { limit: 100 });
      const transaction = items.find(t => t.reference === reference && t.userId === ctx.user!.userId);
      if (!transaction) return error('Billing transaction not found', 404);
      const names = await secrets.listSecretNames();
      if (!names.includes('PAYSTACK_SECRET_KEY')) return error('Paystack is not configured yet.', 503);
      const secret = await secrets.readSecret('PAYSTACK_SECRET_KEY');
      let response: Response;
      let data: any;
      try {
        const result = await paystackRequest(secret, `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${secret}` } });
        response = result.response;
        data = result.data;
      } catch (e: any) {
        return error((typeof e?.message === 'string' ? e.message : 'Could not reach Paystack during verification.').slice(0, 480), 502);
      }
      if (!response.ok || !data?.status || !data.data) {
        const failure = paystackFailure('transaction verification', response, data);
        console.error('Paystack verification failure', { userId: ctx.user!.userId, reference, detail: failure.message });
        return error(failure.message, 502);
      }
      const payment = data.data;
      if (payment.reference !== reference) return error('Payment reference mismatch', 409);
      const paymentStatus = String(payment.status || '').toLowerCase();
      if (paymentStatus !== 'success') {
        const persistedStatus = ['pending','processing','ongoing','queued'].includes(paymentStatus) ? paymentStatus : ['failed','abandoned','reversed'].includes(paymentStatus) ? paymentStatus : 'pending';
        await db.update(table('billingTransactions', ws.workspaceId), [{ id:transaction.id, record:{ ...transaction, status:persistedStatus, gatewayStatus:paymentStatus, gatewayMessage:typeof payment.gateway_response === 'string' ? payment.gateway_response : typeof payment.message === 'string' ? payment.message : null, updatedAt:now() } }]);
        if (['pending','processing','ongoing','queued'].includes(paymentStatus)) return json({ verified:false, pending:true, status:paymentStatus, plan:transaction.plan, reference });
        return error(`Payment was not successful: ${paymentStatus || 'unknown'}`, 402);
      }
      if (Number(payment.amount) !== Number(transaction.amountMinor) || String(payment.currency).toUpperCase() !== String(transaction.currency).toUpperCase()) return error('Verified payment amount or currency does not match the authorized transaction', 409);
      if (transaction.status === 'success' && transaction.subscriptionCode) return json({ verified:true, plan:transaction.plan, subscription:{ status:'active', subscriptionCode:transaction.subscriptionCode }, alreadyVerified:true });
      let subscriptionCode = payment.subscription?.subscription_code || payment.subscription_code || '';
      if (!subscriptionCode && payment.customer?.customer_code) {
        try {
          const customerCode = String(payment.customer.customer_code);
          const subscriptionsResult = await paystackRequest(secret, `https://api.paystack.co/subscription?perPage=100&customer=${encodeURIComponent(customerCode)}`, { headers: { Authorization: `Bearer ${secret}` } });
          const remoteSubscriptions = Array.isArray(subscriptionsResult.data?.data) ? subscriptionsResult.data.data : [];
          const matching = remoteSubscriptions.find((candidate: any) => Number(candidate.amount) === Number(transaction.amountMinor) && ['active','non-renewing','attention'].includes(String(candidate.status || '').toLowerCase()));
          subscriptionCode = matching?.subscription_code ? String(matching.subscription_code) : '';
        } catch (lookupError) {
          console.error('Paystack subscription lookup after successful payment failed', { userId: ctx.user!.userId, reference, detail: lookupError instanceof Error ? lookupError.message : 'unknown lookup error' });
        }
      }
      const updated = { ...transaction, status:'success', gatewayStatus:payment.status, paidAt:payment.paid_at || now(), gatewayTransactionId:payment.id || null, subscriptionCode:subscriptionCode || null, updatedAt:now() };
      await db.update(table('billingTransactions', ws.workspaceId), [{ id:transaction.id, record:updated }]);
      if (!subscriptionCode) return error('Payment succeeded but the Paystack subscription could not yet be identified; no paid access was granted. Please refresh Billing shortly.', 409);
      const { items: subs } = await db.list<any>(table('subscriptions', ws.workspaceId), { limit:100 });
      const current = subs.find(s => s.subscriptionCode === subscriptionCode || s.userId === ctx.user!.userId);
      const subscription = { ...(current || {}), userId:ctx.user!.userId, plan:transaction.plan, subscriptionCode, status:'active', gateway:'paystack', amountMinor:transaction.amountMinor, currency:transaction.currency, activatedAt:current?.activatedAt || now(), updatedAt:now() };
      if (current) await db.update(table('subscriptions', ws.workspaceId), [{ id:current.id, record:subscription }]);
      else await db.add(table('subscriptions', ws.workspaceId), [subscription]);
      const wsUpdated = { ...ws, plan:transaction.plan, updatedAt:now() };
      await db.update(table('workspacesByUser', ctx.user!.userId), [{ id:ws.id, record:wsUpdated }]);
      await indexSubscription(subscriptionCode, ws.workspaceId, ctx.user!.userId);
      return json({ verified:true, plan:transaction.plan, subscription:{ status:'active', subscriptionCode } });
    },
  ],
  'POST /api/billing/webhook': [
    async ctx => {
      const names = await secrets.listSecretNames();
      if (!names.includes('PAYSTACK_SECRET_KEY')) return error('Webhook is not configured', 503);
      const secret = await secrets.readSecret('PAYSTACK_SECRET_KEY');
      const headers = (ctx.event?.headers || {}) as Record<string, string>;
      const signature = headers['x-paystack-signature'] || headers['X-Paystack-Signature'];
      const rawBody = typeof ctx.event?.body === 'string' ? (ctx.event.isBase64Encoded ? Buffer.from(ctx.event.body, 'base64').toString('utf8') : ctx.event.body) : JSON.stringify(ctx.body || {});
      if (!signature) return error('Missing Paystack signature', 401);
      const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
      if (signature !== expected) return error('Invalid Paystack signature', 401);
      const body = parseBody(ctx.body);
      const eventId = typeof body.id === 'number' || typeof body.id === 'string' ? String(body.id) : `${body.event || 'unknown'}:${body.data && typeof body.data === 'object' && 'reference' in body.data ? String((body.data as any).reference) : crypto.randomUUID()}`;
      const eventTable = `billingEventById:${encodeURIComponent(eventId)}`;
      const { items: existingEvent } = await db.list<any>(eventTable, { limit: 1 });
      if (existingEvent[0]) return json({ received:true, duplicate:true });
      const markProcessed = async () => {
        await db.add(eventTable, [{ eventId, event:body.event || 'unknown', processedAt:now() }]);
      };
      const data = body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : {};
      const reference = typeof data.reference === 'string' ? data.reference : '';
      const eventSubscriptionCode = typeof data.subscription_code === 'string' ? data.subscription_code : (data.subscription && typeof data.subscription === 'object' && 'subscription_code' in data.subscription ? String((data.subscription as any).subscription_code) : '');
      const referenceWorkspace = reference.match(/^recovely_(.+-workspace)_/);
      let workspaceId = referenceWorkspace?.[1] || '';
      let ownerId = workspaceId.endsWith('-workspace') ? workspaceId.slice(0, -'-workspace'.length) : '';
      if (!workspaceId && eventSubscriptionCode) {
          const { items: indexed } = await db.list<any>(`billingSubscriptionByCode:${encodeURIComponent(eventSubscriptionCode)}`, { limit: 1 });
        const match = indexed[0];
        workspaceId = match?.workspaceId || '';
        ownerId = match?.ownerId || '';
      }
      if (!workspaceId) return json({ received:true });
      if (!ownerId) return json({ received:true });
      const { items: workspaceRows } = await db.list<any>(table('workspacesByUser', ownerId), { limit:1 });
      const ws = workspaceRows[0];
      if (!ws || ws.workspaceId !== workspaceId) return json({ received:true });
      const paymentStatus = typeof data.status === 'string' ? data.status : '';
      const subscriptionCode = typeof data.subscription_code === 'string' ? data.subscription_code : (data.subscription && typeof data.subscription === 'object' && 'subscription_code' in data.subscription ? String((data.subscription as any).subscription_code) : '');
      if (body.event === 'subscription.disable' || body.event === 'subscription.not_renew') {
        if (!eventSubscriptionCode) return json({ received:true });
        const { items: lifecycleSubs } = await db.list<any>(table('subscriptions', workspaceId), { limit:100 });
        const lifecycle = lifecycleSubs.find(s => s.subscriptionCode === eventSubscriptionCode);
        if (lifecycle) {
          const completed = body.event === 'subscription.disable' && String(data.status || '').toLowerCase() === 'complete';
          const nextStatus = body.event === 'subscription.disable' ? (completed ? 'expired' : 'cancelled') : 'active_nonrenewing';
          await db.update(table('subscriptions', workspaceId), [{ id:lifecycle.id, record:{ ...lifecycle, status:nextStatus, updatedAt:now(), cancelledAt:body.event === 'subscription.disable' ? now() : lifecycle.cancelledAt || null } }]);
          if (body.event === 'subscription.disable') {
            const { items: ownerRows } = await db.list<any>(table('workspacesByUser', ownerId), { limit:1 });
            const ownerWs = ownerRows[0];
            if (ownerWs && ownerWs.workspaceId === workspaceId) await db.update(table('workspacesByUser', ownerId), [{ id:ownerWs.id, record:{ ...ownerWs, plan:'free', updatedAt:now() } }]);
          }
        }
        await markProcessed();
        return json({ received:true });
      }
      if (body.event === 'charge.failed' || body.event === 'invoice.payment_failed') {
        const { items: failedSubs } = await db.list<any>(table('subscriptions', workspaceId), { limit:100 });
        if (eventSubscriptionCode) {
          const failed = failedSubs.find(s => s.subscriptionCode === eventSubscriptionCode);
          if (failed) await db.update(table('subscriptions', workspaceId), [{ id:failed.id, record:{ ...failed, status:'payment_failed', lastPaymentFailedAt:now(), updatedAt:now() } }]);
        }
        await markProcessed();
        return json({ received:true });
      }
      if (body.event === 'charge.success') {
        if (paymentStatus !== 'success') { await markProcessed(); return json({ received:true }); }
        const { items: transactions } = await db.list<any>(table('billingTransactions', workspaceId), { limit:100 });
        const transaction = transactions.find(t => t.reference === reference);
        if (!transaction) { await markProcessed(); return json({ received:true }); }
        if (Number(data.amount) !== Number(transaction.amountMinor) || String(data.currency).toUpperCase() !== String(transaction.currency).toUpperCase()) return error('Webhook payment amount or currency mismatch', 409);
        if (!subscriptionCode) return error('Successful subscription charge has no subscription code', 409);
        const updated = { ...transaction, status:'success', gatewayStatus:'success', paidAt:typeof data.paid_at === 'string' ? data.paid_at : now(), gatewayTransactionId:data.id || null, subscriptionCode, updatedAt:now() };
        await db.update(table('billingTransactions', workspaceId), [{ id:transaction.id, record:updated }]);
        const { items: subs } = await db.list<any>(table('subscriptions', workspaceId), { limit:100 });
        const current = subs.find(s => s.subscriptionCode === subscriptionCode || s.userId === transaction.userId);
        const subscription = { ...(current || {}), userId:transaction.userId, plan:transaction.plan, subscriptionCode, status:'active', gateway:'paystack', amountMinor:transaction.amountMinor, currency:transaction.currency, activatedAt:current?.activatedAt || now(), updatedAt:now() };
        if (current) await db.update(table('subscriptions', workspaceId), [{ id:current.id, record:subscription }]);
        else await db.add(table('subscriptions', workspaceId), [subscription]);
        await indexSubscription(subscriptionCode, workspaceId, ownerId);
        await db.update(table('workspacesByUser', ownerId), [{ id:ws.id, record:{ ...ws, plan:transaction.plan, updatedAt:now() } }]);
        await markProcessed();
      }
      return json({ received:true });
    },
  ],
});

