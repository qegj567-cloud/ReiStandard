/**
 * GET /api/v1/messages
 * 功能：查询用户的定时任务列表
 * ReiStandard v1.0.0
 */

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

async function core(url, headers) {
  const h = normalizeHeaders(headers);
  const userId = h['x-user-id'];

  if (!userId) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'USER_ID_REQUIRED',
          message: '必须提供 X-User-Id 请求头'
        }
      }
    };
  }

  // 解析查询参数
  const u = new URL(url, 'https://dummy');
  const status = u.searchParams.get('status') || 'all';
  const contactName = u.searchParams.get('contactName');
  const messageSubtype = u.searchParams.get('messageSubtype');
  const limit = Math.min(parseInt(u.searchParams.get('limit') || '20'), 100);
  const offset = parseInt(u.searchParams.get('offset') || '0');

  // 构建查询条件
  const conditions = ['user_id = $1'];
  const params = [userId];
  let paramIndex = 2;

  if (status !== 'all') {
    conditions.push(`status = $${paramIndex}`);
    params.push(status);
    paramIndex++;
  }
  if (contactName) {
    conditions.push(`contact_name = $${paramIndex}`);
    params.push(contactName);
    paramIndex++;
  }
  if (messageSubtype) {
    conditions.push(`message_subtype = $${paramIndex}`);
    params.push(messageSubtype);
    paramIndex++;
  }

  /*
  // 查询任务列表
  const tasks = await sql`
    SELECT
      id, uuid, contact_name, message_type, message_subtype,
      next_send_at, recurrence_type, status, retry_count,
      created_at, updated_at
    FROM scheduled_messages
    WHERE ${sql.raw(conditions.join(' AND '))}
    ORDER BY next_send_at ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  // 查询总数
  const totalResult = await sql`
    SELECT COUNT(*) as count
    FROM scheduled_messages
    WHERE ${sql.raw(conditions.join(' AND '))}
  `;

  const total = parseInt(totalResult.rows[0].count);
  */

  // 模拟数据
  const tasks = [];
  const total = 0;

  console.log('[messages] Query tasks:', {
    userId,
    status,
    limit,
    offset,
    total
  });

  return {
    status: 200,
    body: {
      success: true,
      data: {
        tasks: tasks.map(task => ({
          id: task.id,
          uuid: task.uuid,
          contactName: task.contact_name,
          messageType: task.message_type,
          messageSubtype: task.message_subtype,
          nextSendAt: task.next_send_at,
          recurrenceType: task.recurrence_type,
          status: task.status,
          retryCount: task.retry_count,
          createdAt: task.created_at,
          updatedAt: task.updated_at
        })),
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total
        }
      }
    }
  };
}

module.exports = async function(req, res) {
  try {
    if (req.method !== 'GET') return sendNodeJson(res, 405, { error: 'Method not allowed' });
    const result = await core(req.url, req.headers);
    return sendNodeJson(res, result.status, result.body);
  } catch (error) {
    console.error('[messages] Error:', error);
    return sendNodeJson(res, 500, { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: '服务器内部错误，请稍后重试' } });
  }
};

exports.handler = async function(event) {
  try {
    if (event.httpMethod !== 'GET') return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method not allowed' }) };
    const url = event.rawUrl || `https://dummy${event.path}${event.rawQuery ? '?' + event.rawQuery : ''}`;
    const result = await core(url, event.headers || {});
    return { statusCode: result.status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(result.body) };
  } catch (error) {
    console.error('[messages] Error:', error);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: '服务器内部错误，请稍后重试' } }) };
  }
};
