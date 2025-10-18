/**
 * POST /api/v1/schedule-message
 * 功能：创建定时消息任务（CommonJS，兼容 Vercel 与 Netlify）
 * ReiStandard v1.0.0
 */

const { deriveUserEncryptionKey, decryptPayload, encryptForStorage } = require('../../lib/encryption');
const { validateScheduleMessagePayload } = require('../../lib/validation');
const { randomUUID } = require('crypto');
const { sql } = require('@vercel/postgres'); // 确保引入 sql

function normalizeHeaders(h) {
  const out = {};
  for (const k in h || {}) out[k.toLowerCase()] = h[k];
  return out;
}

function sendNodeJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // 哼，CORS的通行证在这里也要发一遍，确保万无一失
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,POST,PUT,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, x-payload-encrypted, x-encryption-version, x-user-id');
  res.end(JSON.stringify(body));
}

async function core(headers, body) {
  const h = normalizeHeaders(headers);
// ▼▼▼ 把这几行加进去 ▼▼▼
  console.log("[Noir Debug Server] Received Headers:", JSON.stringify(h)); // 记录所有收到的头信息
  const receivedUserId = h['x-user-id']; // 用小写读取
  console.log("[Noir Debug Server] Received User ID for Decryption:", receivedUserId);
  // ▲▲▲ 添加结束 ▲▲▲
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
    // 验证加密数据格式 (Noir's Fix: CBC模式没有authTag!)
if (!encryptedBody.iv || !encryptedBody.encryptedData) {
    return {
        status: 400,
        body: {
            success: false,
            error: {
                code: 'INVALID_ENCRYPTED_PAYLOAD',
                message: '加密数据格式错误 (缺少 iv 或 encryptedData)' // 可以加个更明确的提示
            }
        }
    };
}
    // 派生用户专属密钥并解密
    const userKey = deriveUserEncryptionKey(userId);
    payload = decryptPayload(encryptedBody, userKey);
console.log("[Noir Debug Server] Decrypted Payload for Validation:", JSON.stringify(payload, null, 2)); // 打印解密后的完整内容
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
            message: '请求体不是有效的JSON' // 修正错误消息
          }
        }
      };
    }

    console.error('[schedule-message] Decryption internal error:', error); // 增加内部错误日志
    // 对于未知错误，返回通用错误信息
    return {
        status: 500,
        body: {
            success: false,
            error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: '解密过程中发生未知错误'
            }
        }
    };
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

  // 4. 加密敏感字段 (哼，这里只加密需要存数据库的user_message)
  const userKeyForStorage = deriveUserEncryptionKey(userId); // 用同一个密钥没关系
  const encryptedUserMessage = payload.content ? encryptForStorage(payload.content, userKeyForStorage) : null;

  // 5. 生成 UUID
  const taskUuid = randomUUID();

// 确保 `INSERT INTO` 前面没有多余的制表符或空格！
const result = await sql`
  INSERT INTO scheduled_messages (
    user_id,
    uuid,
    contact_name,
    avatar_url,
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
    ${payload.contactName || '未知联系人'},
    ${payload.avatarUrl || null}, 
    ${payload.messageType},
    ${encryptedUserMessage},
    ${payload.firstSendTime},
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
    status: 201, // 201 Created 代表资源创建成功
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
}

// Node.js handler (Vercel)
module.exports = async function(req, res) {
  // 哼，这就是我加的“前台接线员”，专门处理OPTIONS电话
  if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,POST,PUT,DELETE');
      // 确保这里包含了所有前端会发送的头部
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
// ▼▼▼ 把这行加进去 ▼▼▼
        console.log("[Noir Debug Server] Received RAW Body:", body);
        // ▲▲▲ 添加结束 ▲▲▲
    const result = await core(req.headers, body);
    return sendNodeJson(res, result.status, result.body);
  } catch (error) {
    console.error('[schedule-message] Error:', error);
    // 如果是数据库连接错误，给出更明确的提示
    if (error.message.includes('connect')) {
         return sendNodeJson(res, 503, { // 503 Service Unavailable
             success: false,
             error: { code: 'DATABASE_CONNECTION_ERROR', message: '无法连接到数据库' }
         });
    }
    return sendNodeJson(res, 500, {
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: '服务器内部错误，请稍后重试'
      }
    });
  }
}; // <--- 确保这里有一个分号或者大括号来结束 module.exports

// Netlify handler (保持不变，但也要确保它在 module.exports 之后)
exports.handler = async function(event) {
  // ... (Netlify 的代码保持不变) ...
  // 哼，Netlify的接线员也得加上
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS,PATCH,POST,PUT,DELETE',
        'Access-Control-Allow-Headers': 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, x-payload-encrypted, x-encryption-version, x-user-id'
      },
      body: ''
    };
  }
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
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*' // Netlify 也需要 CORS
      },
      body: JSON.stringify(result.body)
    };
  } catch (error) {
    console.error('[schedule-message] Netlify Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: '服务器内部错误，请稍后重试'
        }
      })
    };
  }
}; // <--- 确保Netlify的handler也有结束符号
