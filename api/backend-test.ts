const BACKEND = 'https://recovely-b77j28.v2.appdeploy.ai';

export default async function handler(req: any, res: any) {
  try {
    const response = await fetch(`${BACKEND}/api/_healthcheck`);
    const text = await response.text();

    res.status(200).json({
      vercelFunction: true,
      appDeployStatus: response.status,
      appDeployBody: text,
    });
  } catch (error) {
    res.status(500).json({
      vercelFunction: true,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
