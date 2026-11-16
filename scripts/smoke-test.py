"""
End-to-end smoke test for a LOCAL Worker against a throwaway local MongoDB.
Never point this at Atlas or production. See README "Local smoke test".

  ROTSI_ADMIN_TOKEN=... python3 -I scripts/smoke-test.py
"""
import json, hmac, hashlib, base64, os, urllib.request, subprocess, time, sys
B = os.environ.get("ROTSI_BASE_URL", "http://localhost:8799")
ADMIN = os.environ["ROTSI_ADMIN_TOKEN"]
CONTAINER = os.environ.get("ROTSI_MONGO_CONTAINER", "rotsi-mongo-test")
master = [l.split("=",1)[1].strip() for l in open(".dev.vars") if l.startswith("MASTER_KEY=")][0]

def hkdf(ikm, salt, info, n=32):
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:n]
cbkey = hkdf(base64.b64decode(master), b"rotsi-payments", b"callbacks/v1")
def sig(kind, ref): return hmac.new(cbkey, f"{kind}:{ref}".encode(), hashlib.sha256).hexdigest()[:32]

def req(method, path, body=None, token=None, headers=None):
    h = {"content-type": "application/json"}
    if token: h["authorization"] = f"Bearer {token}"
    h.update(headers or {})
    r = urllib.request.Request(B + path, method=method, headers=h, data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(r) as resp: return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read())

fails = 0
def check(name, cond, info=""):
    global fails
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {info}"))
    if not cond: fails += 1

def mongo(js):
    return subprocess.run(["docker","exec",CONTAINER,"mongosh","--quiet","rotsi_payments_dev","--eval",js],capture_output=True,text=True).stdout.strip()

s, r = req("POST", "/v1/admin/database/initialize", token=ADMIN); check("init indexes", s == 200 and r["data"]["indexes"] >= 10, r)
slug = f"smoke-{int(time.time())}"
s, r = req("POST", "/v1/admin/businesses", {"name": "Smoke A", "slug": slug}, ADMIN); check("create business", s == 201, r); biz = r["data"]["id"]
s, r = req("POST", "/v1/admin/businesses", {"name": "Smoke A", "slug": slug}, ADMIN); check("duplicate slug 409", s == 409, r)
s, r = req("POST", f"/v1/admin/businesses/{biz}/api-keys", {"environment": "sandbox"}, ADMIN); check("create test key", s == 201 and r["data"]["apiKey"].startswith("rk_test_"), r); key = r["data"]["apiKey"]
s, r = req("POST", f"/v1/admin/businesses/{biz}/api-keys", {"environment": "sandbox", "scopes": ["payments:read","payouts:write"]}, ADMIN); pkey = r["data"]["apiKey"]
s, r = req("POST", f"/v1/admin/businesses/{biz}/api-keys", {"environment": "production"}, ADMIN); lkey = r["data"]["apiKey"]
s, r = req("PUT", f"/v1/admin/businesses/{biz}/webhooks/sandbox", {"url": "http://127.0.0.1/x"}, ADMIN); check("webhook rejects non-https/IP", s == 422, r)
s, r = req("PUT", f"/v1/admin/businesses/{biz}/webhooks/sandbox", {"url": "https://example.com/rotsi-hook"}, ADMIN); check("webhook set, secret once", s == 200 and r["data"]["secret"].startswith("whsec_"), r)
check("no plaintext secrets in DB", "whsec_" not in mongo("JSON.stringify(db.payments_businesses.find().toArray())") and key not in mongo("JSON.stringify(db.payments_api_keys.find().toArray())"))

s, r = req("GET", "/v1/businesses/me", token=key); check("businesses/me", s == 200 and r["data"]["environment"] == "sandbox", r)
s, r = req("POST", "/v1/stk-push", {}, key); check("idempotency key required", s == 400, r)
s, r = req("POST", "/v1/stk-push", {"phone": "123", "amount": 1.5}, key, {"idempotency-key": "idem-0001"}); check("validation 422", s == 422, r)
stk = {"phone": "0712345678", "amount": 10, "accountReference": "INV1", "description": "Test"}
s, r = req("POST", "/v1/stk-push", stk, key, {"idempotency-key": "idem-0001"}); check("stk without mpesa account 409", s == 409, r)
s, r = req("POST", "/v1/stk-push", stk, lkey, {"idempotency-key": "idem-0001"}); check("live key blocked by kill switch", s == 403 and r["error"]["code"] == "LIVE_PAYMENTS_DISABLED", r)

acct = {"shortcode": "174379", "shortcodeType": "paybill", "consumerKey": "fake-consumer-key-123", "consumerSecret": "fake-consumer-secret-123", "passkey": "fake-passkey-123456", "initiatorName": "testapi", "securityCredential": "x"*40}
s, r = req("PUT", f"/v1/admin/businesses/{biz}/mpesa/sandbox", acct, ADMIN); check("configure sandbox mpesa", s == 200 and r["data"]["payoutsEnabled"] is False, r)
check("daraja creds encrypted at rest", "fake-consumer" not in mongo("JSON.stringify(db.payments_daraja_accounts.find().toArray())"))

s, r = req("POST", "/v1/stk-push", stk, key, {"idempotency-key": "idem-0002"}); check("stk with bad Daraja creds -> FAILED (not UNKNOWN)", s == 202 and r["data"]["status"] == "FAILED", r); failed_txn = r["data"]["id"]
s, r2 = req("POST", "/v1/stk-push", stk, key, {"idempotency-key": "idem-0002"}); check("idempotent replay returns same txn", s == 200 and r2["data"]["id"] == failed_txn, r2)
s, r = req("POST", "/v1/stk-push", {**stk, "amount": 11}, key, {"idempotency-key": "idem-0002"}); check("idempotency key reuse w/ different body 409", s == 409, r)

s, r = req("POST", "/v1/b2c/payments", {"phone": "0712345678", "amount": 50, "remarks": "Refund"}, key, {"idempotency-key": "idem-0003"}); check("b2c needs payouts scope", s == 403 and r["error"]["code"] == "FORBIDDEN", r)
s, r = req("POST", "/v1/b2c/payments", {"phone": "0712345678", "amount": 50, "remarks": "Refund"}, pkey, {"idempotency-key": "idem-0003"}); check("b2c needs admin approval", s == 403 and r["error"]["code"] == "PAYOUTS_NOT_APPROVED", r)

# Simulate a PROCESSING STK transaction, then a signed Safaricom callback.
tid = mongo(f"""const t=db.payments_transactions.findOne({{_id: ObjectId("{failed_txn[4:]}")}}); const id=new ObjectId(); db.payments_transactions.insertOne({{...t, _id:id, status:"PROCESSING", idempotencyKey:"idem-sim", checkoutRequestId:"ws_CO_TEST", resultCode:undefined, resultDescription:undefined}}); print(id.toHexString())""").splitlines()[-1]
RCPT = f"TST{int(time.time())}"
cb = {"Body": {"stkCallback": {"MerchantRequestID": "m1", "CheckoutRequestID": "ws_CO_TEST", "ResultCode": 0, "ResultDesc": "OK", "CallbackMetadata": {"Item": [{"Name": "Amount", "Value": 10}, {"Name": "MpesaReceiptNumber", "Value": RCPT}, {"Name": "PhoneNumber", "Value": 254712345678}]}}}}
s, r = req("POST", f"/v1/hooks/stk/{tid}/{'0'*32}", cb); check("forged callback signature 404", s == 404, r)
s, r = req("POST", f"/v1/hooks/stk/{tid}/{sig('stk', tid)}", cb); check("signed STK callback acked", s == 200 and r["ResultCode"] == 0, r)
s, r = req("GET", f"/v1/transactions/txn_{tid}", token=key); check("txn SUCCESS with receipt", r["data"]["status"] == "SUCCESS" and r["data"]["receipt"] == RCPT, r)
s, r = req("POST", f"/v1/hooks/stk/{tid}/{sig('stk', tid)}", cb); check("duplicate callback acked", s == 200, r)
cbf = json.loads(json.dumps(cb)); cbf["Body"]["stkCallback"]["ResultCode"] = 1032; del cbf["Body"]["stkCallback"]["CallbackMetadata"]
req("POST", f"/v1/hooks/stk/{tid}/{sig('stk', tid)}", cbf)
s, r = req("GET", f"/v1/transactions/txn_{tid}", token=key); check("final SUCCESS not overwritten by later FAILED; flagged", r["data"]["status"] == "SUCCESS" and r["data"].get("needsReview") is True, r)
hist = mongo(f'db.payments_transactions.findOne({{_id: ObjectId("{tid}")}}).statusHistory.map(h=>h.status).join(",")')
check("status history recorded", hist.endswith("SUCCESS"), hist)

# C2B confirmation: signed per account
acc_id = mongo('print(db.payments_daraja_accounts.find().sort({_id:-1}).limit(1).toArray()[0]._id.toHexString())').splitlines()[-1]
c2b = {"TransactionType": "Pay Bill", "TransID": f"C2B{int(time.time())}", "TransAmount": "250.00", "BusinessShortCode": "174379", "BillRefNumber": "ACC9", "MSISDN": "254708374149", "FirstName": "Jane"}
s, r = req("POST", f"/v1/hooks/c2b-validation/{acc_id}/{sig('c2b-validation', acc_id)}", c2b); check("c2b validation accepts", r.get("ResultCode") == "0", r)
s, r = req("POST", f"/v1/hooks/c2b-confirmation/{acc_id}/{sig('c2b-confirmation', acc_id)}", c2b); check("c2b confirmation acked", s == 200, r)
req("POST", f"/v1/hooks/c2b-confirmation/{acc_id}/{sig('c2b-confirmation', acc_id)}", c2b)
s, r = req("GET", "/v1/transactions?type=C2B", token=key); check("c2b recorded exactly once", s == 200 and len(r["data"]["items"]) == 1 and r["data"]["items"][0]["amount"] == 250, r)

# Tenant isolation
s, r = req("POST", "/v1/admin/businesses", {"name": "Smoke B", "slug": slug + "-b"}, ADMIN); biz_b = r["data"]["id"]
s, r = req("POST", f"/v1/admin/businesses/{biz_b}/api-keys", {"environment": "sandbox"}, ADMIN); key_b = r["data"]["apiKey"]
s, r = req("GET", f"/v1/transactions/txn_{tid}", token=key_b); check("tenant B cannot read tenant A txn", s == 404, r)
s, r = req("GET", "/v1/transactions", token=key_b); check("tenant B list empty", r["data"]["items"] == [], r)

check("webhook deliveries queued", int(mongo("print(db.payments_webhook_deliveries.countDocuments())").splitlines()[-1]) >= 2)
s, r = req("GET", "/v1/admin/review", token=ADMIN); check("admin review queue shows flagged txn", any(i["id"] == f"txn_{tid}" for i in r["data"]), r)
print("\nFAILURES:", fails)
sys.exit(1 if fails else 0)
