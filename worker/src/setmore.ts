import type { SetmoreCustomer } from "./model";

const BASE_URL = "https://developer.setmore.com/api/v1";
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export class SetmoreError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class SetmoreClient {
  private accessToken: string | null = null;

  constructor(private readonly refreshToken: string, private readonly retries = 4) {}

  private async getAccessToken(): Promise<string> {
    const url = `${BASE_URL}/o/oauth2/token?refreshToken=${encodeURIComponent(this.refreshToken)}`;
    const resp = await fetch(url);
    const body = await resp.text();
    if (!resp.ok) {
      throw new SetmoreError(`Setmore token exchange failed (HTTP ${resp.status}): ${body.slice(0, 300)}`);
    }
    const token = (JSON.parse(body) as { data?: { token?: { access_token?: string } } }).data?.token
      ?.access_token;
    if (!token) throw new SetmoreError(`Unexpected Setmore token response: ${body.slice(0, 300)}`);
    return token;
  }

  private async request<T>(path: string, params: Record<string, string>): Promise<T> {
    this.accessToken ??= await this.getAccessToken();
    const url = `${BASE_URL}${path}?${new URLSearchParams(params)}`;
    for (let attempt = 0; attempt < this.retries; attempt++) {
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
      });
      if (RETRY_STATUSES.has(resp.status)) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      const body = await resp.text();
      if (!resp.ok) {
        throw new SetmoreError(`Setmore ${path} failed (HTTP ${resp.status}): ${body.slice(0, 300)}`);
      }
      return JSON.parse(body) as T;
    }
    throw new SetmoreError("Setmore API rate limited after retries");
  }

  /**
   * Setmore has no "list customers" endpoint, so customers are collected from
   * their appointments. Dates are dd-mm-yyyy.
   */
  async fetchCustomers(startDate: string, endDate: string): Promise<SetmoreCustomer[]> {
    const customers = new Map<string, SetmoreCustomer>();
    let cursor: string | null = null;
    while (true) {
      const params: Record<string, string> = { startDate, endDate, customerDetails: "true" };
      if (cursor) params.cursor = cursor;

      const payload = await this.request<{
        data?: { appointments?: { customer?: SetmoreCustomer }[]; cursor?: string | null };
      }>("/bookingapi/appointments", params);
      const appointments = payload.data?.appointments ?? [];
      cursor = payload.data?.cursor ?? null;

      for (const appt of appointments) {
        const cust = appt.customer;
        // Later appointments may carry more complete customer details.
        if (cust?.key) customers.set(cust.key, cust);
      }

      if (!cursor || appointments.length === 0) break;
      await sleep(400);
    }
    return [...customers.values()];
  }
}
