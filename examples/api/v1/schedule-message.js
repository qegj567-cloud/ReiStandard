/**
 * POST /api/v1/schedule-message
 * 功能：创建定时消息任务（CommonJS，兼容 Vercel 与 Netlify）
 * ReiStandard v1.0.0
 */
 const { sql } = require('@vercel/postgres'); // 确保这行在文件顶部

const { deriveUserEncryptionKey, decryptPayload, encryptForStorage } = require('../../lib/encryption');
const { validateScheduleMessagePayload } = require('../../lib/validation');
const { randomUUID } = require('crypto');
// const { sql } = require('@vercel/postgres');

function normalizeHeaders(h) {
  const out = {};
  for (const k in h || {}) out[k.toLowerCase()] = h[k];
  return out;
}

function sendNodeJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function core(headers, body) {
  const h = normalizeHeaders(headers);

  // 1. 验证加密头部
  const isEncrypted = h['x-payload-encrypted'] === 'true';
  const encryptionVersion = h['x-encryption-version'];
  const userId = h['x-user-id'];

  if (!isEncrypted) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'ENCRYPTION_REQUIRED',
          message: '请求体必须加密'
        }
      }
    };
  }

  if (!userId) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'USER_ID_REQUIRED',
          message: '缺少用户标识符'
        }
      }
    };
  }

  if (encryptionVersion !== '1') {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'UNSUPPORTED_ENCRYPTION_VERSION',
          message: '加密版本不支持'
        }
      }
    };
  }

  // 2. 解密请求体
  let payload;
  try {
    const encryptedBody = typeof body === 'string' ? JSON.parse(body) : body;

    // 验证加密数据格式
    if (!encryptedBody.iv || !encryptedBody.authTag || !encryptedBody.encryptedData) {
      return {
        status: 400,
        body: {
          success: false,
          error: {
            code: 'INVALID_ENCRYPTED_PAYLOAD',
            message: '加密数据格式错误'
          }
        }
      };
    }

    // 派生用户专属密钥并解密
    const userKey = deriveUserEncryptionKey(userId);
    payload = decryptPayload(encryptedBody, userKey);

  } catch (error) {
    if (error.message.includes('auth') || error.message.includes('Unsupported state')) {
      return {
        status: 400,
        body: {
          success: false,
          error: {
            code: 'DECRYPTION_FAILED',
            message: '请求体解密失败'
          }
        }
      };
    }

    if (error instanceof SyntaxError) {
      return {
        status: 400,
        body: {
          success: false,
          error: {
            code: 'INVALID_PAYLOAD_FORMAT',
            message: '解密后的数据不是有效 JSON'
          }
        }
      };
    }

    throw error;
  }

  // 3. 验证业务参数
  const validationResult = validateScheduleMessagePayload(payload);
  if (!validationResult.valid) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: validationResult.errorCode,
          message: validationResult.errorMessage,
          details: validationResult.details
        }
      }
    };
  }

  // 4. 加密敏感字段用于数据库存储
  const userKey = deriveUserEncryptionKey(userId);
  const encryptedApiKey = payload.apiKey ? encryptForStorage(payload.apiKey, userKey) : null;
  const encryptedPrompt = payload.completePrompt ? encryptForStorage(payload.completePrompt, userKey) : null;
  const encryptedUserMessage = payload.userMessage ? encryptForStorage(payload.userMessage, userKey) : null;

  // 5. 生成 UUID（如果未提供）
  const taskUuid = payload.uuid || randomUUID();

  // 6. 插入数据库


// 6. 插入数据库
const result = await sql`
  INSERT INTO scheduled_messages (
    user_id,
    uuid,
    message_type,
    user_message,
    next_send_at,
    push_subscription,
    status,
    created_at,
    updated_at
  ) VALUES (
    ${userId},
    ${taskUuid},
    ${payload.messageType},
    ${encryptedUserMessage},
    ${payload.scheduled_at},
    ${JSON.stringify(payload.subscription)},
    'pending',
    NOW(),
    NOW()
  )
  RETURNING id, uuid, next_send_at, status, created_at
`;

const dbResult = result.rows[0];

console.log('[schedule-message] New task created:', {
    taskId: dbResult.id,
    nextSendAt: dbResult.next_send_at
});

// 7. 返回成功响应
return {
    status: 201,
    body: {
        success: true,
        data: {
            id: dbResult.id,
            uuid: dbResult.uuid,
            nextSendAt: dbResult.next_send_at,
            status: dbResult.status,
            createdAt: dbResult.created_at
        }
    }
};
// Node.js handler (Vercel)
module.exports = async function(req, res) {
  // 哼，这就是我加的“前台接线员”，专门处理OPTIONS电话
if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,POST,PUT,DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, x-payload-encrypted, x-encryption-version, x-user-id');
    res.writeHead(200);
    res.end();
    return;
}
// 接线员工作完毕
  try {
    if (req.method !== 'POST') return sendNodeJson(res, 405, { error: 'Method not allowed' });

    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
    }

    const result = await core(req.headers, body);
    return sendNodeJson(res, result.status, result.body);
  } catch (error) {
    console.error('[schedule-message] Error:', error);
    return sendNodeJson(res, 500, {
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: '服务器内部错误，请稍后重试'
      }
    });
  }
};

// Netlify handler
exports.handler = async function(event) {
  try {
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }

    const result = await core(event.headers || {}, event.body);
    return {
      statusCode: result.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(result.body)
    };
  } catch (error) {
    console.error('[schedule-message] Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: '服务器内部错误，请稍后重试'
        }
      })
    };
  }
};
