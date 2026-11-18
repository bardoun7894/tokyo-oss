import { Connection, Client } from '@temporalio/client';

export const TEMPORAL_NAMESPACE = 'tokyo-prod';
export const TEMPORAL_TASK_QUEUE = 'tokyo-wa';

function temporalAddress(): string {
  return process.env.TEMPORAL_ADDRESS || '100.64.0.1:7233';
}

let clientPromise: Promise<Client> | null = null;

/** Lazily-created, cached client connection. On connection failure the cache
 *  is cleared so the next call retries instead of permanently failing. */
export async function getTemporalClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const connection = await Connection.connect({ address: temporalAddress() });
      return new Client({ connection, namespace: TEMPORAL_NAMESPACE });
    })();
  }
  try {
    return await clientPromise;
  } catch (err) {
    clientPromise = null;
    throw err;
  }
}

const clientsByNamespace = new Map<string, Promise<Client>>();

/** Cached client for another namespace (the on-call system uses `oncall`). Same retry-on-failure rule as above. */
export async function getTemporalClientFor(namespace: string): Promise<Client> {
  let p = clientsByNamespace.get(namespace);
  if (!p) {
    p = (async () => {
      const connection = await Connection.connect({ address: temporalAddress() });
      return new Client({ connection, namespace });
    })();
    clientsByNamespace.set(namespace, p);
  }
  try {
    return await p;
  } catch (err) {
    clientsByNamespace.delete(namespace);
    throw err;
  }
}

export function isTemporalEnabled(): boolean {
  return process.env.WA_TEMPORAL === '1';
}
