<?php
/**
 * Example server endpoint for Megapay transaction status (NexaTrade).
 *
 * Calls: POST https://megapay.co.ke/backend/v1/transactionstatus
 * Body:  { api_key, email, transaction_request_id }
 *
 * WHY THIS EXISTS:
 * - api_key is SECRET and must never be in browser code. Host this on your server
 *   and set window.NEXATRADE_MEGAPAY_CONFIG.statusUrl to this script's URL.
 *
 * IMPORTANT:
 * - Checking status from the browser must NOT credit a user balance. If status is
 *   successful, your trusted server/webhook flow should credit the deposit
 *   idempotently (store and reject duplicate transaction/event IDs) and update
 *   the ledger atomically. You may extend this endpoint to perform that verified,
 *   idempotent crediting server-side if desired.
 */

// === CONFIGURE ON SERVER (do not commit real secrets) ===
$MEGAPAY_API_KEY = getenv('MEGAPAY_API_KEY') ?: '';
$MEGAPAY_EMAIL   = getenv('MEGAPAY_EMAIL') ?: '';
$MEGAPAY_STATUS_URL = 'https://megapay.co.ke/backend/v1/transactionstatus';

header('Content-Type: application/json; charset=utf-8');
// header('Access-Control-Allow-Origin: https://your-frontend.example.com');
// header('Access-Control-Allow-Headers: Content-Type');
// header('Access-Control-Allow-Methods: POST, OPTIONS');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Method not allowed. Use POST.']);
    exit;
}

$raw = file_get_contents('php://input');
$input = json_decode($raw, true);
if (!is_array($input)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Invalid JSON body.']);
    exit;
}

$transactionRequestId = '';
foreach (['transaction_request_id', 'transactionRequestId', 'reference', 'request_id'] as $key) {
    if (isset($input[$key]) && trim((string)$input[$key]) !== '') {
        $transactionRequestId = trim((string)$input[$key]);
        break;
    }
}
$email = isset($input['email']) && $input['email'] !== '' ? (string)$input['email'] : $MEGAPAY_EMAIL;

if ($MEGAPAY_API_KEY === '') {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'Server is not configured: set MEGAPAY_API_KEY.']);
    exit;
}

if ($transactionRequestId === '') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'transaction_request_id is required.']);
    exit;
}

$payload = json_encode([
    'api_key'                => $MEGAPAY_API_KEY,
    'email'                  => $email,
    'transaction_request_id' => $transactionRequestId,
]);

$ch = curl_init($MEGAPAY_STATUS_URL);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $payload,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
    CURLOPT_TIMEOUT        => 30,
]);

$response = curl_exec($ch);
$curlErr  = curl_error($ch);
$httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($response === false) {
    http_response_code(502);
    echo json_encode(['ok' => false, 'error' => 'Could not reach Megapay.', 'detail' => $curlErr]);
    exit;
}

// Forward Megapay's response to the frontend as-is (JSON). Do not credit a
// balance based on a browser-triggered check; credit only from verified,
// idempotent server-side processing/webhook.
http_response_code($httpCode >= 200 && $httpCode < 600 ? $httpCode : 502);
$decoded = json_decode($response, true);
if ($decoded === null) {
    echo json_encode(['ok' => true, 'raw' => $response, 'transaction_request_id' => $transactionRequestId]);
} else {
    if (!isset($decoded['transaction_request_id'])) {
        $decoded['transaction_request_id'] = $transactionRequestId;
    }
    echo json_encode($decoded);
}
