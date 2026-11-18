/**
 * API wrappers for the Products Catalog. Built on top of the shared
 * `api` / `postApi` / `patchApi` helpers, except for the forward preview
 * step: the backend intentionally returns HTTP 400 with a `preview` body
 * when `confirm` is not `true` (CONTRACT.md), and `postApi` throws away the
 * response body on any non-2xx. previewForward() talks to fetch directly so
 * that "400 with a preview" is read as data, not swallowed as an error.
 */
import { api, patchApi, postApi } from "./client";
import type {
  BatchDetail,
  BatchSummary,
  ForwardPreview,
  ForwardTarget,
  Product,
  ProductsResponse,
  ProductsStats,
  SortOrder,
} from "../lib/products";

export interface ProductsQuery {
  sort?: SortOrder;
  q?: string;
  min?: string;
  max?: string;
  status?: "new" | "kept" | "hidden" | "all";
  unpriced?: boolean;
  batch?: string;
  limit?: number;
  offset?: number;
}

function toQueryString(q: ProductsQuery): string {
  const params = new URLSearchParams();
  if (q.sort) params.set("sort", q.sort);
  if (q.q) params.set("q", q.q);
  if (q.min) params.set("min", q.min);
  if (q.max) params.set("max", q.max);
  if (q.status) params.set("status", q.status);
  if (q.unpriced) params.set("unpriced", "1");
  if (q.batch) params.set("batch", q.batch);
  params.set("limit", String(q.limit ?? 60));
  params.set("offset", String(q.offset ?? 0));
  return params.toString();
}

export function fetchProducts(q: ProductsQuery): Promise<ProductsResponse> {
  return api<ProductsResponse>(`/api/products?${toQueryString(q)}`);
}

export function fetchStats(): Promise<ProductsStats> {
  return api<ProductsStats>("/api/products/stats");
}

export function syncProducts(): Promise<{ scanned: number; added: number; paired: number; unpriced: number; batches: number }> {
  return postApi("/api/products/sync");
}

export interface ProductPatch {
  price?: number | null;
  title?: string;
  brand?: string;
  status?: Product["status"];
  notes?: string;
}

export function patchProduct(id: number, body: ProductPatch): Promise<Product> {
  return patchApi<Product>(`/api/products/${id}`, body as unknown as Record<string, unknown>);
}

export function fetchBatches(): Promise<{ batches: BatchSummary[] }> {
  return api<{ batches: BatchSummary[] }>("/api/products/batches");
}

export function fetchBatchDetail(batchId: string): Promise<BatchDetail> {
  return api<BatchDetail>(`/api/products/batches/${encodeURIComponent(batchId)}`);
}

export function assignBatch(
  batchId: string,
  pairs: Array<{ productId: number; priceMessageId: number | null }>,
): Promise<{ updated: number }> {
  return postApi(`/api/products/batches/${encodeURIComponent(batchId)}/assign`, { pairs });
}

export function fetchForwardTargets(): Promise<{ targets: ForwardTarget[] }> {
  return api<{ targets: ForwardTarget[] }>("/api/products/forward-targets");
}

export interface ForwardBody {
  ids: number[];
  jid: string;
  withPrice: boolean;
  markup?: number;
  note?: string;
}

/**
 * Always calls without `confirm`, so the server's 400+preview safety path
 * fires. Returns the preview body. Throws only on a genuinely unexpected
 * response (no `preview` field, or a non-400 error).
 */
export async function previewForward(body: ForwardBody): Promise<ForwardPreview> {
  const res = await fetch("/api/products/forward", {
    method: "POST",
    headers: { Authorization: `Bearer ${window.__TOKEN__ ?? ""}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, confirm: false }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 400 && data && typeof data === "object" && "preview" in data) {
    return (data as { preview: ForwardPreview }).preview;
  }
  throw new Error((data as { error?: string }).error ?? `Preview failed: ${res.status}`);
}

export function confirmForward(
  body: ForwardBody,
): Promise<{ sent: number; failed: number; errors: Array<{ id: number; message: string }> }> {
  return postApi("/api/products/forward", { ...body, confirm: true });
}
