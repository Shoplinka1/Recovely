import {
  router,
  json,
  error,
  requireAuth as sdkRequireAuth,
  auth,
  type RouterMiddleware,
} from '@appdeploy/sdk';
import {
  db,
  storage,
  secrets,
  invites,
  isInviteError,
} from '@appdeploy/sdk';
import {
  createHmac,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
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
  'https://recovely.vercel.app',
]);

const AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const AUTH_HANDOFF_TTL_MS = 2 * 60 * 1000;

const SUPABASE_URL = 'https://fyxywsocbfcnbprlknfp.supabase.co';
const SUPABASE_ISSUER = `${SUPABASE_URL}/auth/v1`;

const SUPABASE_JWKS = createRemoteJWKSet(
  new URL(`${SUPABASE_ISSUER}/.well-known/jwks.json`)
);

const hashAuthValue = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const verifySupabaseAccessToken = async (token: string) => {
  try {
    const { payload } = await jwtVerify(token, SUPABASE_JWKS, {
      issuer: SUPABASE_ISSUER,
      audience: 'authenticated',
    });

    if (typeof payload.sub !== 'string' || !payload.sub.trim()) {
      return null;
    }

    const metadata =
      payload.user_metadata && typeof payload.user_metadata === 'object'
        ? (payload.user_metadata as Record<string, unknown>)
        : {};

    const metadataName =
      typeof metadata.full_name === 'string'
        ? metadata.full_name.trim()
        : '';

    const name =
      metadataName ||
      (typeof payload.email === 'string'
        ? payload.email.split('@')[0]
        : '');

    return {
      userId: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      name,
      scope:
        typeof payload.role === 'string'
          ? payload.role
          : 'authenticated',
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
  Promised: [
    'Due',
    'Partially Recovered',
    'Recovered',
    'Disputed',
    'Paused',
  ],
  Due: [
    'Overdue',
    'Partially Recovered',
    'Recovered',
    'Disputed',
    'Paused',
  ],
  Overdue: [
    'Partially Recovered',
    'Recovered',
    'Disputed',
    'Written Off',
    'Paused',
  ],
  'Partially Recovered': [
    'Due',
    'Overdue',
    'Recovered',
    'Disputed',
    'Paused',
  ],
  Recovered: ['Verified', 'Closed', 'Partially Recovered'],
  Verified: ['Closed', 'Recovered'],
  Closed: ['Recovered', 'Verified'],
  Paused: ['Preparing', 'Submitted', 'Due', 'Cancelled'],
  Disputed: ['Under Review', 'Due', 'Cancelled', 'Written Off'],
  Cancelled: ['Identified'],
  'Written Off': ['Identified'],
};

const table = (kind: string, workspaceId: string) =>
  `${kind}:${workspaceId}`;

const now = () => new Date().toISOString();

const parseBody = (body: unknown) =>
  body && typeof body === 'object'
    ? (body as Record<string, unknown>)
    : {};

const requireString = (
  v: unknown,
  name: string,
  max = 500
) => {
  if (
    typeof v !== 'string' ||
    !v.trim() ||
    v.length > max
  ) {
    throw new Error(`${name} is required`);
  }

  return v.trim();
};

const requireMoney = (v: unknown) => {
  if (
    typeof v !== 'number' ||
    !Number.isInteger(v) ||
    v <= 0
  ) {
    throw new Error(
      'Amount must be a positive integer minor-unit value'
    );
  }

  return v;
};

/**
 * Resolve the workspace belonging to the authenticated user.
 *
 * Important:
 * A missing membership does NOT automatically make the user Owner.
 * Only workspace.ownerId can establish ownership.
 */
const workspaceFor = async (userId: string) => {
  const { items } = await db.list<any>(
    table('workspacesByUser', userId),
    {
      limit: 100,
    }
  );

  if (items[0]) {
    let workspace = items.find(
      item => item.ownerId === userId
    ) || items[0];

    if (
      workspace.ownerId &&
      workspace.ownerId !== userId
    ) {
      const { items: ownerWorkspaces } =
        await db.list<any>(
          table('workspacesByUser', workspace.ownerId),
          { limit: 100 }
        );

      const ownerWorkspace = ownerWorkspaces.find(
        item => item.workspaceId === workspace.workspaceId
      );

      if (ownerWorkspace) {
        workspace = ownerWorkspace;
      }
    }

    const { items: members } = await db.list<any>(
      table('members', workspace.workspaceId),
      { limit: 100 }
    );

    const existingMember = members.find(
      member => member.userId === userId
    );

    if (!existingMember) {
      await db.add(
        table('members', workspace.workspaceId),
        [
          {
            userId,
            role:
              workspace.ownerId === userId
                ? 'Owner'
                : 'Member',
            createdAt: now(),
          },
        ]
      );
    } else if (
      workspace.ownerId === userId &&
      existingMember.role !== 'Owner'
    ) {
      await db.update(
        table('members', workspace.workspaceId),
        [
          {
            id: existingMember.id,
            record: {
              ...existingMember,
              role: 'Owner',
            },
          },
        ]
      );
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

  const [id] = await db.add(
    table('workspacesByUser', userId),
    [record]
  );

  if (!id) {
    throw new Error('Could not initialize workspace');
  }

  await db.add(
    table('members', workspaceId),
    [
      {
        userId,
        role: 'Owner',
        createdAt,
      },
    ]
  );

  return {
    id,
    ...record,
  };
};

const indexSubscription = async (
  subscriptionCode: string,
  workspaceId: string,
  ownerId: string
) => {
  if (!subscriptionCode) return;

  const indexTable =
    `billingSubscriptionByCode:${encodeURIComponent(subscriptionCode)}`;

  const { items: existing } =
    await db.list<any>(indexTable, {
      limit: 1,
    });

  if (existing[0]) return;

  await db.add(
    indexTable,
    [
      {
        subscriptionCode,
        workspaceId,
        ownerId,
        createdAt: now(),
      },
    ]
  );
};

const BILLING_USD_NGN_RATE = 1400;

const billingAmountNgnMinor = (
  plan: 'pro' | 'business'
) =>
  Math.round(
    (plan === 'pro' ? 9 : 29) *
      BILLING_USD_NGN_RATE *
      100
  );

type PaystackResult = {
  response: Response;
  data: any;
};

const paystackRequest = async (
  secret: string,
  url: string,
  init: RequestInit = {},
  timeoutMs = 10000
): Promise<PaystackResult> => {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));

    return {
      response,
      data,
    };
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new Error(
        `Paystack request timed out after ${timeoutMs / 1000}s.`
      );
    }

    throw new Error(
      `Could not reach Paystack: ${
        typeof e?.message === 'string'
          ? e.message
          : 'network error'
      }`
    );
  } finally {
    clearTimeout(timeout);
  }
};

const paystackFailure = (
  stage: string,
  response: Response | null,
  data: any
) => {
  const parts = [`Paystack ${stage} failed`];

  if (response) {
    parts.push(`HTTP ${response.status}`);
  }

  if (
    typeof data?.message === 'string' &&
    data.message.trim()
  ) {
    parts.push(data.message.trim());
  }

  if (
    typeof data?.code === 'string' &&
    data.code.trim()
  ) {
    parts.push(`Code: ${data.code.trim()}`);
  }

  if (
    typeof data?.type === 'string' &&
    data.type.trim()
  ) {
    parts.push(`Type: ${data.type.trim()}`);
  }

  const nextStep =
    data?.meta?.nextStep ||
    data?.meta?.next_step;

  if (
    typeof nextStep === 'string' &&
    nextStep.trim()
  ) {
    parts.push(nextStep.trim());
  }

  return new Error(
    parts.join(' — ').slice(0, 420)
  );
};

const validatePaystackSecret = async (
  secret: string
) => {
  const { response, data } =
    await paystackRequest(
      secret,
      'https://api.paystack.co/plan?perPage=1',
      {
        headers: {
          Authorization: `Bearer ${secret}`,
        },
      }
    );

  if (!response.ok || !data.status) {
    throw paystackFailure(
      'authentication check',
      response,
      data
    );
  }
};

const ensurePaystackPlan = async (
  secret: string,
  plan: 'pro' | 'business'
) => {
  const amount = billingAmountNgnMinor(plan);

  const name =
    plan === 'pro'
      ? 'Recovely Pro NGN'
      : 'Recovely Business NGN';

  const cacheTable =
    `billingPlanByName:${plan}`;

  const { items: cached } =
    await db.list<any>(cacheTable, {
      limit: 1,
    });

  if (cached[0]?.planCode) {
    const { response, data } =
      await paystackRequest(
        secret,
        `https://api.paystack.co/plan/${encodeURIComponent(
          String(cached[0].planCode)
        )}`,
        {
          headers: {
            Authorization: `Bearer ${secret}`,
          },
        }
      );

    const remote = data?.data;

    if (
      response.ok &&
      data?.status &&
      remote?.plan_code &&
      Number(remote.amount) === amount &&
      String(remote.interval) === 'monthly' &&
      String(remote.currency || '').toUpperCase() ===
        'NGN'
    ) {
      return String(remote.plan_code);
    }
  }

  const {
    response: listResponse,
    data: listData,
  } = await paystackRequest(
    secret,
    `https://api.paystack.co/plan?perPage=100&amount=${amount}&interval=monthly`,
    {
      headers: {
        Authorization: `Bearer ${secret}`,
      },
    }
  );

  if (!listResponse.ok || !listData?.status) {
    throw paystackFailure(
      'plan lookup',
      listResponse,
      listData
    );
  }

  const plans = Array.isArray(listData.data)
    ? listData.data
    : Array.isArray(listData.data?.data)
      ? listData.data.data
      : [];

  const existing = plans.find(
    (p: any) =>
      String(p.name) === name &&
      Number(p.amount) === amount &&
      String(p.interval) === 'monthly' &&
      String(p.currency || '').toUpperCase() ===
        'NGN'
  );

  if (existing?.plan_code) {
    const planCode = String(
      existing.plan_code
    );

    await db.add(
      cacheTable,
      [
        {
          plan,
          planCode,
          amountMinor: amount,
          currency: 'NGN',
          interval: 'monthly',
          updatedAt: now(),
        },
      ]
    );

    return planCode;
  }

  const {
    response: createResponse,
    data: createData,
  } = await paystackRequest(
    secret,
    'https://api.paystack.co/plan',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        amount,
        interval: 'monthly',
        currency: 'NGN',
        send_invoices: true,
      }),
    }
  );

  if (
    !createResponse.ok ||
    !createData?.status ||
    !createData.data?.plan_code
  ) {
    throw paystackFailure(
      'plan creation',
      createResponse,
      createData
    );
  }

  const planCode = String(
    createData.data.plan_code
  );

  await db.add(
    cacheTable,
    [
      {
        plan,
        planCode,
        amountMinor: amount,
        currency: 'NGN',
        interval: 'monthly',
        createdAt: now(),
      },
    ]
  );

  return planCode;
};
const baseHealth = () =>
  json({
    ok: true,
    service: 'recovely',
    timestamp: now(),
  });

const event = async (
  workspaceId: string,
  recoveryId: string,
  userId: string,
  type: string,
  data: Record<string, unknown> = {}
) => {
  await db.add(
    table('events', workspaceId),
    [
      {
        recoveryId,
        userId,
        type,
        data,
        createdAt: now(),
      },
    ]
  );
};

const notify = async (
  workspaceId: string,
  userId: string,
  type: string,
  title: string,
  message: string,
  recoveryId?: string
) => {
  await db.add(
    table('notifications', workspaceId),
    [
      {
        userId,
        type,
        title,
        message,
        recoveryId: recoveryId || null,
        createdAt: now(),
        readAt: null,
      },
    ]
  );
};

const refreshOperationalNotifications = async (
  workspaceId: string,
  userId: string
) => {
  const { items } = await db.list<any>(
    table('recoveries', workspaceId),
    { limit: 100 }
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const recovery of items) {
    if (
      !recovery.dueDate ||
      ['Closed', 'Cancelled', 'Written Off'].includes(
        recovery.status
      )
    ) {
      continue;
    }

    const due = new Date(recovery.dueDate);
    if (Number.isNaN(due.getTime())) continue;

    due.setHours(0, 0, 0, 0);

    if (due < today) {
      if (
        !['Overdue', 'Partially Recovered', 'Recovered'].includes(
          recovery.status
        )
      ) {
        continue;
      }

      const { items: existing } = await db.list<any>(
        table('notifications', workspaceId),
        { limit: 100 }
      );

      const alreadyNotified = existing.some(
        n =>
          n.userId === userId &&
          n.recoveryId === recovery.id &&
          n.type === 'overdue' &&
          !n.readAt
      );

      if (!alreadyNotified) {
        await notify(
          workspaceId,
          userId,
          'overdue',
          'Recovery overdue',
          `${recovery.title || 'A recovery'} is overdue.`,
          recovery.id
        );
      }
    }
  }
};

const csvEscape = (value: unknown) => {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = String(value);

  if (
    stringValue.includes(',') ||
    stringValue.includes('"') ||
    stringValue.includes('\n') ||
    stringValue.includes('\r')
  ) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
};

const toCsv = (
  rows: Record<string, unknown>[]
) => {
  if (!rows.length) return '';

  const columns = Array.from(
    new Set(rows.flatMap(row => Object.keys(row)))
  );

  const header = columns.map(csvEscape).join(',');

  const body = rows.map(row =>
    columns
      .map(column => csvEscape(row[column]))
      .join(',')
  );

  return [header, ...body].join('\n');
};

const memberRole = async (
  workspaceId: string,
  userId: string
) => {
  const { items } = await db.list<any>(
    table('members', workspaceId),
    {
      limit: 100,
    }
  );

  const member = items.find(
    item => item.userId === userId
  );

  const { items: mappings } =
    await db.list<any>(
      table('workspacesByUser', userId),
      {
        limit: 100,
      }
    );

  const mapping = mappings.find(
    item => item.workspaceId === workspaceId
  );

  const isOwner =
    mapping?.ownerId === userId;

  if (isOwner) {
    if (
      member &&
      member.role !== 'Owner'
    ) {
      await db.update(
        table('members', workspaceId),
        [
          {
            id: member.id,
            record: {
              ...member,
              role: 'Owner',
            },
          },
        ]
      );
    } else if (!member) {
      await db.add(
        table('members', workspaceId),
        [
          {
            userId,
            role: 'Owner',
            createdAt: now(),
          },
        ]
      );
    }

    return 'Owner';
  }

  return member?.role || null;
};

const requireWorkspaceRole = async (
  workspaceId: string,
  userId: string,
  allowed: string[]
) => {
  const role = await memberRole(
    workspaceId,
    userId
  );

  if (!role || !allowed.includes(role)) {
    throw error(
      `Workspace role required: ${allowed.join(', ')}`,
      403
    );
  }

  return role;
};

const parseCookie = (
  headers: Record<string, unknown>,
  name: string
) => {
  const cookieHeader =
    Object.entries(headers).find(
      ([key]) =>
        key.toLowerCase() === 'cookie'
    )?.[1];

  if (typeof cookieHeader !== 'string') {
    return '';
  }

  const cookies = cookieHeader
    .split(';')
    .map(part => part.trim());

  for (const cookie of cookies) {
    const index = cookie.indexOf('=');

    if (index === -1) continue;

    const key = cookie
      .slice(0, index)
      .trim();

    if (key !== name) continue;

    const value = cookie
      .slice(index + 1)
      .trim();

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return '';
};

const requireAuth: RouterMiddleware = async (
  ctx,
  next
) => {
  const headers =
    ctx.event?.headers || {};

  const cookieSession =
    parseCookie(
      headers,
      'recovely_session'
    );

  const customSession =
    cookieSession ||
    (
      Object.entries(headers).find(
        ([key]) =>
          key.toLowerCase() ===
          'x-recovely-session'
      )?.[1] as
        | string
        | undefined
    ) ||
    '';

  if (
    typeof customSession === 'string' &&
    customSession.trim()
  ) {
    const sessionHash =
      hashAuthValue(
        customSession.trim()
      );

    const { items } =
      await db.list<any>(
        `authSession:${sessionHash}`,
        {
          limit: 1,
        }
      );

    const session = items[0];

    if (
      session &&
      session.expiresAt > Date.now() &&
      session.user?.userId
    ) {
      ctx.user = session.user;
      return next();
    }
  }

  const authorization =
    Object.entries(headers).find(
      ([key]) =>
        key.toLowerCase() ===
        'authorization'
    )?.[1];

  if (
    typeof authorization === 'string'
  ) {
    const match =
      authorization.match(
        /^Bearer\s+(.+)$/i
      );

    if (match?.[1]) {
      const supabaseUser =
        await verifySupabaseAccessToken(
          match[1].trim()
        );

      if (supabaseUser) {
        ctx.user = supabaseUser;
        return next();
      }
    }
  }

  const user =
    await auth.getUser(ctx.event);

  if (!user) {
    return error(
      'Unauthorized',
      401
    );
  }

  ctx.user = user;
  return next();
};

const getRecovery = async (
  workspaceId: string,
  recoveryId: string
) => {
  const { items } =
    await db.list<any>(
      table('recoveries', workspaceId),
      {
        limit: 100,
      }
    );

  return items.find(
    item => item.id === recoveryId
  );
};

const getSubscriptionByReference =
  async (reference: string) => {
    const { items } =
      await db.list<any>(
        `billingTransactionByReference:${encodeURIComponent(
          reference
        )}`,
        {
          limit: 1,
        }
      );

    return items[0] || null;
  };

const planPriceUsd = (
  plan: string
) => {
  if (plan === 'pro') return 9;
  if (plan === 'business') return 29;
  return 0;
};

const activePlan = (
  plan: unknown
) =>
  plan === 'pro' ||
  plan === 'business';

const planLimit = (
  plan: unknown
) => {
  if (plan === 'free') return 5;
  return Infinity;
};

const isClosedStatus = (
  status: string
) =>
  [
    'Closed',
    'Cancelled',
    'Written Off',
  ].includes(status);

const numericMinor = (
  value: unknown
) => {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    return null;
  }

  return value;
};

const safeDate = (
  value: unknown
) => {
  if (
    typeof value !== 'string' ||
    !value.trim()
  ) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
};

const normalizeCurrency = (
  value: unknown
) => {
  if (
    typeof value !== 'string'
  ) {
    return null;
  }

  const currency =
    value.trim().toUpperCase();

  return CURRENCIES.includes(
    currency
  )
    ? currency
    : null;
};

const normalizePriority = (
  value: unknown
) => {
  if (
    typeof value !== 'string'
  ) {
    return null;
  }

  return PRIORITIES.includes(
    value
  )
    ? value
    : null;
};

const normalizeStatus = (
  value: unknown
) => {
  if (
    typeof value !== 'string'
  ) {
    return null;
  }

  return STATUSES.includes(
    value
  )
    ? value
    : null;
};

const normalizeType = (
  value: unknown
) => {
  if (
    typeof value !== 'string'
  ) {
    return null;
  }

  return TYPES.includes(
    value
  )
    ? value
    : null;
};
router.get(
  '/api/health',
  async () => baseHealth()
);

router.get(
  '/api/healthcheck',
  async () => baseHealth()
);

router.post(
  '/api/feedback',
  [
    requireAuth,
    async ctx => {
      const ws = await workspaceFor(
        ctx.user!.userId
      );

      const body = parseBody(ctx.body);

      let message: string;

      try {
        message = requireString(
          body.message,
          'Message',
          5000
        );
      } catch (e: any) {
        return error(
          e?.message || 'Message is required',
          400
        );
      }

      const category =
        typeof body.category === 'string'
          ? body.category.trim().slice(0, 100)
          : 'General';

      const [id] = await db.add(
        table('feedback', ws.workspaceId),
        [
          {
            userId: ctx.user!.userId,
            email: ctx.user!.email || '',
            category,
            message,
            createdAt: now(),
          },
        ]
      );

      if (!id) {
        return error(
          'Could not save feedback',
          500
        );
      }

      return json(
        {
          ok: true,
          id,
        },
        201
      );
    },
  ]
);

router.get(
  '/api/feedback',
  [
    requireAuth,
    async ctx => {
      const ws = await workspaceFor(
        ctx.user!.userId
      );

      const role =
        await memberRole(
          ws.workspaceId,
          ctx.user!.userId
        );

      if (
        !role ||
        !['Owner', 'Admin'].includes(role)
      ) {
        return error(
          'Owner or Admin role required',
          403
        );
      }

      const { items } =
        await db.list<any>(
          table('feedback', ws.workspaceId),
          {
            limit: 100,
          }
        );

      return json({
        items: items.sort(
          (a, b) =>
            String(b.createdAt || '').localeCompare(
              String(a.createdAt || '')
            )
        ),
      });
    },
  ]
);

router.post(
  '/api/auth/session',
  async ctx => {
    const origin =
      Object.entries(
        ctx.event?.headers || {}
      ).find(
        ([key]) =>
          key.toLowerCase() === 'origin'
      )?.[1];

    if (
      typeof origin === 'string' &&
      !AUTH_HANDOFF_ORIGINS.has(origin)
    ) {
      return error(
        'Authentication handoff origin is not allowed',
        403
      );
    }

    const user =
      await sdkRequireAuth(ctx.event);

    if (!user) {
      return error(
        'Unauthorized',
        401
      );
    }

    const sessionId =
      randomBytes(32).toString('hex');

    const sessionHash =
      hashAuthValue(sessionId);

    const createdAt = Date.now();

    const [sessionRecordId] =
      await db.add(
        `authSession:${sessionHash}`,
        [
          {
            user,
            createdAt,
            expiresAt:
              createdAt +
              AUTH_SESSION_TTL_MS,
          },
        ]
      );

    if (!sessionRecordId) {
      return error(
        'Could not establish authenticated workspace session',
        500
      );
    }

    const response = json({
      ok: true,
      user,
      expiresIn:
        Math.floor(
          AUTH_SESSION_TTL_MS / 1000
        ),
    });

    response.headers[
      'Set-Cookie'
    ] =
      `recovely_session=${encodeURIComponent(
        sessionId
      )}; Path=/; Max-Age=${Math.floor(
        AUTH_SESSION_TTL_MS / 1000
      )}; HttpOnly; Secure; SameSite=Lax`;

    return response;
  }
);

router.post(
  '/api/auth/session/logout',
  async ctx => {
    const headers =
      ctx.event?.headers || {};

    const session =
      parseCookie(
        headers,
        'recovely_session'
      ) ||
      (
        Object.entries(headers).find(
          ([key]) =>
            key.toLowerCase() ===
            'x-recovely-session'
        )?.[1] as
          | string
          | undefined
      ) ||
      '';

    if (session) {
      const sessionHash =
        hashAuthValue(
          session.trim()
        );

      const { items } =
        await db.list<any>(
          `authSession:${sessionHash}`,
          {
            limit: 1,
          }
        );

      if (items[0]?.id) {
        await db.delete(
          `authSession:${sessionHash}`,
          [items[0].id]
        );
      }
    }

    const response = json({
      ok: true,
    });

    response.headers[
      'Set-Cookie'
    ] =
      'recovely_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';

    return response;
  }
);

router.post(
  '/api/auth/redeem',
  async ctx => {
    const body =
      parseBody(ctx.body);

    const code =
      typeof body.code === 'string'
        ? body.code.trim()
        : '';

    if (!code) {
      return error(
        'Authentication handoff code is required',
        400
      );
    }

    const key =
      `authHandoff:${hashAuthValue(code)}`;

    const { items } =
      await db.list<any>(
        key,
        {
          limit: 1,
        }
      );

    const handoff = items[0];

    if (!handoff) {
      return error(
        'Authentication handoff is invalid or expired',
        401
      );
    }

    if (
      handoff.expiresAt <= Date.now()
    ) {
      return error(
        'Authentication handoff is expired',
        401
      );
    }

    if (!handoff.user?.userId) {
      return error(
        'Authentication handoff is invalid',
        401
      );
    }

    if (handoff.id) {
      await db.delete(
        key,
        [handoff.id]
      );
    }

    const sessionId =
      randomBytes(32).toString('hex');

    const sessionHash =
      hashAuthValue(sessionId);

    const createdAt = Date.now();

    const [sessionRecordId] =
      await db.add(
        `authSession:${sessionHash}`,
        [
          {
            user: handoff.user,
            createdAt,
            expiresAt:
              createdAt +
              AUTH_SESSION_TTL_MS,
          },
        ]
      );

    if (!sessionRecordId) {
      return error(
        'Could not establish authenticated workspace session',
        500
      );
    }

    const response = json({
      ok: true,
      user: handoff.user,
      expiresIn:
        Math.floor(
          AUTH_SESSION_TTL_MS / 1000
        ),
    });

    response.headers[
      'Set-Cookie'
    ] =
      `recovely_session=${encodeURIComponent(
        sessionId
      )}; Path=/; Max-Age=${Math.floor(
        AUTH_SESSION_TTL_MS / 1000
      )}; HttpOnly; Secure; SameSite=Lax`;

    return response;
  }
);

router.post(
  '/api/auth/supabase-session',
  async ctx => {
    const body =
      parseBody(ctx.body);

    const accessToken =
      typeof body.accessToken === 'string'
        ? body.accessToken.trim()
        : '';

    if (!accessToken) {
      return error(
        'Supabase access token is required',
        400
      );
    }

    const user =
      await verifySupabaseAccessToken(
        accessToken
      );

    if (!user) {
      return error(
        'Supabase session is invalid or expired',
        401
      );
    }

    const sessionId =
      randomBytes(32).toString('hex');

    const sessionHash =
      hashAuthValue(sessionId);

    const createdAt = Date.now();

    const [sessionRecordId] =
      await db.add(
        `authSession:${sessionHash}`,
        [
          {
            user,
            createdAt,
            expiresAt:
              createdAt +
              AUTH_SESSION_TTL_MS,
          },
        ]
      );

    if (!sessionRecordId) {
      return error(
        'Could not establish authenticated workspace session',
        500
      );
    }

    const response = json({
      ok: true,
      user,
      expiresIn:
        Math.floor(
          AUTH_SESSION_TTL_MS / 1000
        ),
    });

    response.headers[
      'Set-Cookie'
    ] =
      `recovely_session=${encodeURIComponent(
        sessionId
      )}; Path=/; Max-Age=${Math.floor(
        AUTH_SESSION_TTL_MS / 1000
      )}; HttpOnly; Secure; SameSite=Lax`;

    return response;
  }
);

router.post(
  '/api/auth/supabase-session/logout',
  async ctx => {
    const headers =
      ctx.event?.headers || {};

    const session =
      parseCookie(
        headers,
        'recovely_session'
      );

    if (session) {
      const sessionHash =
        hashAuthValue(
          session.trim()
        );

      const { items } =
        await db.list<any>(
          `authSession:${sessionHash}`,
          {
            limit: 1,
          }
        );

      if (items[0]?.id) {
        await db.delete(
          `authSession:${sessionHash}`,
          [items[0].id]
        );
      }
    }

    const response = json({
      ok: true,
    });

    response.headers[
      'Set-Cookie'
    ] =
      'recovely_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';

    return response;
  }
);

router.get(
  '/api/bootstrap',
  [
    requireAuth,
    async ctx => {
      const ws =
        await workspaceFor(
          ctx.user!.userId
        );

      await refreshOperationalNotifications(
        ws.workspaceId,
        ctx.user!.userId
      );

      const role =
        await memberRole(
          ws.workspaceId,
          ctx.user!.userId
        );

      const { items } =
        await db.list<any>(
          table('recoveries', ws.workspaceId),
          {
            limit: 100,
          }
        );

      const active =
        items.filter(
          recovery =>
            ![
              'Closed',
              'Cancelled',
              'Written Off',
            ].includes(
              recovery.status
            )
        ).length;

      return json({
        user: {
          userId:
            ctx.user!.userId,
          email:
            ctx.user!.email,
          name:
            ctx.user!.name,
        },
        workspace: {
          ...ws,
          role,
          activeCount: active,
        },
      });
    },
  ]
);

router.put(
  '/api/workspace',
  [
    requireAuth,
    async ctx => {
      const ws =
        await workspaceFor(
          ctx.user!.userId
        );

      const role =
        await memberRole(
          ws.workspaceId,
          ctx.user!.userId
        );

      if (
        !role ||
        !['Owner', 'Admin'].includes(
          role
        )
      ) {
        return error(
          'Owner or Admin role required',
          403
        );
      }

      const body =
        parseBody(ctx.body);

      const updates: Record<
        string,
        unknown
      > = {
        updatedAt: now(),
      };

      if (
        typeof body.name === 'string'
      ) {
        const name =
          body.name.trim();

        if (
          !name ||
          name.length > 120
        ) {
          return error(
            'Workspace name must be between 1 and 120 characters',
            400
          );
        }

        updates.name = name;
      }

      if (
        body.currency !== undefined
      ) {
        const currency =
          normalizeCurrency(
            body.currency
          );

        if (!currency) {
          return error(
            'Unsupported currency',
            400
          );
        }

        updates.currency =
          currency;
      }

      const { items } =
        await db.list<any>(
          table(
            'workspacesByUser',
            ctx.user!.userId
          ),
          {
            limit: 100,
          }
        );

      const workspace =
        items.find(
          item =>
            item.workspaceId ===
            ws.workspaceId
        );

      if (!workspace?.id) {
        return error(
          'Workspace not found',
          404
        );
      }

      await db.update(
        table(
          'workspacesByUser',
          ctx.user!.userId
        ),
        [
          {
            id: workspace.id,
            record: {
              ...workspace,
              ...updates,
            },
          },
        ]
      );

      return json({
        ok: true,
        workspace: {
          ...ws,
          ...updates,
        },
      });
    },
  ]
);
