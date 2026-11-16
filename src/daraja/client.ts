import type { DarajaCredentials } from "../db/models";
import type { Environment } from "../env";
import { errorInfo, log } from "../lib/log";

const BASE_URLS: Record<Environment, string> = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke",
};

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Every Daraja call resolves to one of three outcomes. The distinction is
 * what keeps money safe:
 *  - ok:        Safaricom answered; inspect the body.
 *  - rejected:  Safaricom refused the request (4xx). Nothing was processed.
 *  - uncertain: timeout / network error / 5xx. It MAY have been processed.
 *               Never retry automatically; mark UNKNOWN and reconcile.
 */
export type DarajaResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "rejected"; status: number; code: string; message: string }
  | { kind: "uncertain"; reason: string };

export type AckResponse = {
  ConversationID?: string;
  OriginatorConversationID?: string;
  ResponseCode?: string;
  ResponseDescription?: string;
};

export type StkPushResponse = {
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResponseCode?: string;
  ResponseDescription?: string;
  CustomerMessage?: string;
};

export type StkQueryResponse = {
  ResponseCode?: string;
  ResultCode?: string;
  ResultDesc?: string;
  errorCode?: string;
  errorMessage?: string;
};

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Daraja timestamps are East Africa Time, yyyyMMddHHmmss. */
export function darajaTimestamp(date = new Date()): string {
  return new Date(date.getTime() + 3 * 3600_000).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

export class DarajaClient {
  constructor(
    private readonly environment: Environment,
    private readonly accountId: string,
    private readonly credentials: DarajaCredentials,
  ) {}

  private get baseUrl(): string {
    return BASE_URLS[this.environment];
  }

  private get cacheKey(): string {
    return `${this.environment}:${this.accountId}:${this.credentials.consumerKey.slice(0, 8)}`;
  }

  private async token(): Promise<DarajaResult<string>> {
    const cached = tokenCache.get(this.cacheKey);
    if (cached && cached.expiresAt > Date.now()) return { kind: "ok", data: cached.token };

    const basic = btoa(`${this.credentials.consumerKey}:${this.credentials.consumerSecret}`);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { authorization: `Basic ${basic}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      // No payment request has been sent yet, so this is a safe rejection.
      return { kind: "rejected", status: 0, code: "DARAJA_UNREACHABLE", message: errorInfo(error).message };
    }
    if (!response.ok) {
      return { kind: "rejected", status: response.status, code: "DARAJA_AUTH_FAILED", message: "Daraja authentication failed." };
    }
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: string };
    if (!body.access_token) {
      return { kind: "rejected", status: response.status, code: "DARAJA_AUTH_FAILED", message: "Daraja returned no token." };
    }
    const ttlSeconds = Number(body.expires_in) || 3599;
    tokenCache.set(this.cacheKey, { token: body.access_token, expiresAt: Date.now() + (ttlSeconds - 120) * 1000 });
    return { kind: "ok", data: body.access_token };
  }

  private async post<T>(path: string, payload: Record<string, unknown>): Promise<DarajaResult<T>> {
    const token = await this.token();
    if (token.kind !== "ok") return token;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token.data}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      log("warn", "daraja.request_uncertain", { path, environment: this.environment, ...errorInfo(error) });
      return { kind: "uncertain", reason: "No response from M-Pesa." };
    }

    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }

    if (response.ok) return { kind: "ok", data: body as T };

    if (response.status === 401) tokenCache.delete(this.cacheKey);
    log("warn", "daraja.request_error", {
      path,
      environment: this.environment,
      status: response.status,
      errorCode: body.errorCode,
    });
    if (response.status >= 500) {
      return { kind: "uncertain", reason: String(body.errorMessage ?? `M-Pesa returned HTTP ${response.status}.`) };
    }
    return {
      kind: "rejected",
      status: response.status,
      code: String(body.errorCode ?? `HTTP_${response.status}`),
      message: String(body.errorMessage ?? "M-Pesa rejected the request."),
    };
  }

  // ---------------------------------------------------------------- products

  stkPush(input: {
    shortcode: string;
    passkey: string;
    transactionType: "CustomerPayBillOnline" | "CustomerBuyGoodsOnline";
    partyB: string;
    amount: number;
    msisdn: string;
    callbackUrl: string;
    accountReference: string;
    description: string;
  }) {
    const timestamp = darajaTimestamp();
    return this.post<StkPushResponse>("/mpesa/stkpush/v1/processrequest", {
      BusinessShortCode: input.shortcode,
      Password: btoa(`${input.shortcode}${input.passkey}${timestamp}`),
      Timestamp: timestamp,
      TransactionType: input.transactionType,
      Amount: input.amount,
      PartyA: input.msisdn,
      PartyB: input.partyB,
      PhoneNumber: input.msisdn,
      CallBackURL: input.callbackUrl,
      AccountReference: input.accountReference,
      TransactionDesc: input.description,
    });
  }

  stkQuery(input: { shortcode: string; passkey: string; checkoutRequestId: string }) {
    const timestamp = darajaTimestamp();
    return this.post<StkQueryResponse>("/mpesa/stkpushquery/v1/query", {
      BusinessShortCode: input.shortcode,
      Password: btoa(`${input.shortcode}${input.passkey}${timestamp}`),
      Timestamp: timestamp,
      CheckoutRequestID: input.checkoutRequestId,
    });
  }

  registerC2BUrls(input: {
    shortcode: string;
    responseType: "Completed" | "Cancelled";
    confirmationUrl: string;
    validationUrl: string;
  }) {
    return this.post<AckResponse>("/mpesa/c2b/v2/registerurl", {
      ShortCode: input.shortcode,
      ResponseType: input.responseType,
      ConfirmationURL: input.confirmationUrl,
      ValidationURL: input.validationUrl,
    });
  }

  /** Sandbox only: makes Safaricom send a C2B confirmation to the registered URL. */
  simulateC2B(input: { shortcode: string; commandId: string; amount: number; msisdn: string; billRef: string }) {
    return this.post<AckResponse>("/mpesa/c2b/v1/simulate", {
      ShortCode: input.shortcode,
      CommandID: input.commandId,
      Amount: input.amount,
      Msisdn: input.msisdn,
      BillRefNumber: input.billRef,
    });
  }

  b2c(input: {
    originatorConversationId: string;
    initiatorName: string;
    securityCredential: string;
    commandId: "BusinessPayment" | "SalaryPayment" | "PromotionPayment";
    amount: number;
    shortcode: string;
    msisdn: string;
    remarks: string;
    occasion?: string;
    resultUrl: string;
    timeoutUrl: string;
  }) {
    return this.post<AckResponse>("/mpesa/b2c/v3/paymentrequest", {
      OriginatorConversationID: input.originatorConversationId,
      InitiatorName: input.initiatorName,
      SecurityCredential: input.securityCredential,
      CommandID: input.commandId,
      Amount: input.amount,
      PartyA: input.shortcode,
      PartyB: input.msisdn,
      Remarks: input.remarks,
      QueueTimeOutURL: input.timeoutUrl,
      ResultURL: input.resultUrl,
      Occasion: input.occasion ?? "",
    });
  }

  b2b(input: {
    initiatorName: string;
    securityCredential: string;
    commandId: "BusinessPayBill" | "BusinessBuyGoods";
    amount: number;
    shortcode: string;
    receiverShortcode: string;
    accountReference: string;
    remarks: string;
    resultUrl: string;
    timeoutUrl: string;
  }) {
    return this.post<AckResponse>("/mpesa/b2b/v1/paymentrequest", {
      Initiator: input.initiatorName,
      SecurityCredential: input.securityCredential,
      CommandID: input.commandId,
      SenderIdentifierType: "4",
      RecieverIdentifierType: "4", // sic: Daraja's spelling
      Amount: input.amount,
      PartyA: input.shortcode,
      PartyB: input.receiverShortcode,
      AccountReference: input.accountReference,
      Remarks: input.remarks,
      QueueTimeOutURL: input.timeoutUrl,
      ResultURL: input.resultUrl,
    });
  }

  /** Asynchronous: the answer arrives on resultUrl. Used by reconciliation. */
  transactionStatus(input: {
    initiatorName: string;
    securityCredential: string;
    shortcode: string;
    transactionId?: string;
    originalConversationId?: string;
    resultUrl: string;
    timeoutUrl: string;
  }) {
    return this.post<AckResponse>("/mpesa/transactionstatus/v1/query", {
      Initiator: input.initiatorName,
      SecurityCredential: input.securityCredential,
      CommandID: "TransactionStatusQuery",
      TransactionID: input.transactionId ?? "",
      OriginalConversationID: input.originalConversationId ?? "",
      PartyA: input.shortcode,
      IdentifierType: "4",
      ResultURL: input.resultUrl,
      QueueTimeOutURL: input.timeoutUrl,
      Remarks: "Reconciliation",
      Occasion: "",
    });
  }
}
