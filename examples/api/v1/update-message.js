/**
 * PUT /api/v1/update-message?id={uuid}
 * 功能：更新已存在的定时任务（CommonJS，兼容 Vercel 与 Netlify）
 * ReiStandard v1.0.0
 */

const { deriveUserEncryptionKey, decryptPayload, encryptForStorage } = require('../../lib/encryption');
const { isValidISO8601 } = require('../../lib/validation');
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

async function core(url, headers, body) {
  const h = normalizeHeaders(headers);
  const u = new URL(url, 'https://dummy');
  const taskUuid = u.searchParams.get('id');

  if (!taskUuid) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'TASK_ID_REQUIRED',
          message: '缺少任务ID'
        }
      }
    };
  }

  const userId = h['x-user-id'];

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

  // 解析请求体（可以是加密或非加密）
  const parsedBody = typeof body === 'string' ? JSON.parse(body) : body;
  let updates;

  // 如果是加密请求，先解密
  if (parsedBody.iv && parsedBody.authTag && parsedBody.encryptedData) {
    const userKey = deriveUserEncryptionKey(userId);
    try {
      updates = decryptPayload(parsedBody, userKey);
    } catch (error) {
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
  } else {
    updates = parsedBody;
  }

  // 构建更新字段
  const updateFields = {};
  const userKey = deriveUserEncryptionKey(userId);

  if (updates.completePrompt) {
    updateFields.complete_prompt = encryptForStorage(updates.completePrompt, userKey);
  }
  if (updates.userMessage) {
    updateFields.user_message = encryptForStorage(updates.userMessage, userKey);
  }
  if (updates.nextSendAt) {
    if (!isValidISO8601(updates.nextSendAt)) {
      return {
        status: 400,
        body: {
          success: false,
          error: {
            code: 'INVALID_UPDATE_DATA',
            message: '更新数据格式错误',
            details: { invalidFields: ['nextSendAt'] }
          }
        }
      };
    }
    updateFields.next_send_at = updates.nextSendAt;
  }
  if (updates.recurrenceType) {
    if (!['none', 'daily', 'weekly'].includes(updates.recurrenceType)) {
      return {
        status: 400,
        body: {
          success: false,
          error: {
            code: 'INVALID_UPDATE_DATA',
            message: '更新数据格式错误',
            details: { invalidFields: ['recurrenceType'] }
          }
        }
      };
    }
    updateFields.recurrence_type = updates.recurrenceType;
  }
  if (updates.avatarUrl) {
    updateFields.avatar_url = updates.avatarUrl;
  }
  if (updates.metadata) {
    updateFields.metadata = JSON.stringify(updates.metadata);
  }

  if (Object.keys(updateFields).length === 0) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'INVALID_UPDATE_DATA',
          message: '没有提供有效的更新字段'
        }
      }
    };
  }

  // 更新数据库（确保用户只能更新自己的任务）
  /*
  const result = await sql`
    UPDATE scheduled_messages
    SET ${sql(updateFields)},
        updated_at = NOW()
    WHERE uuid = ${taskUuid}
      AND user_id = ${userId}
      AND status = 'pending'
    RETURNING uuid, updated_at
  `;

  if (result.count === 0) {
    // 检查任务是否存在
    const existing = await sql`
      SELECT status FROM scheduled_messages
      WHERE uuid = ${taskUuid} AND user_id = ${userId}
    `;

    if (existing.count === 0) {
      return {
        status: 404,
        body: {
          success: false,
          error: {
            code: 'TASK_NOT_FOUND',
            message: '指定的任务不存在或已被删除'
          }
        }
      };
    }

    // 任务存在但不是 pending 状态
    return {
      status: 409,
      body: {
        success: false,
        error: {
          code: 'TASK_ALREADY_COMPLETED',
          message: '任务已完成或已失败，无法更新'
        }
      }
    };
  }
  */

  console.log('[update-message] Task updated:', {
    taskUuid,
    updatedFields: Object.keys(updateFields)
  });

  // 模拟成功响应
  return {
    status: 200,
    body: {
      success: true,
      data: {
        uuid: taskUuid,
        updatedFields: Object.keys(updateFields),
        updatedAt: new Date().toISOString()
      }
    }
  };
}

// Node.js handler (Vercel)
module.exports = async function(req, res) {
  try {
    if (req.method !== 'PUT') return sendNodeJson(res, 405, { error: 'Method not allowed' });

    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
    }

    const result = await core(req.url, req.headers, body);
    return sendNodeJson(res, result.status, result.body);
  } catch (error) {
    console.error('[update-message] Error:', error);
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
    if (event.httpMethod !== 'PUT') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }

    const url = event.rawUrl || `https://dummy${event.path}${event.rawQuery ? '?' + event.rawQuery : ''}`;
    const result = await core(url, event.headers || {}, event.body);
    return {
      statusCode: result.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(result.body)
    };
  } catch (error) {
    console.error('[update-message] Error:', error);
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
