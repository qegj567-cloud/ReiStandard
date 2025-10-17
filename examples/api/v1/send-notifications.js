/**
 * POST /api/v1/send-notifications
 * 功能：Cron Job 触发，处理到期的定时消息任务
 * ReiStandard v1.0.0
 */

const webpush = require('web-push');
const { deriveUserEncryptionKey, decryptFromStorage } = require('../../lib/encryption');
// const { sql } = require('@vercel/postgres');

// VAPID 配置验证
const VAPID_EMAIL = process.env.VAPID_EMAIL;
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_EMAIL || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('[send-notifications] VAPID configuration error:', {
    hasEmail: !!VAPID_EMAIL,
    hasPublicKey: !!VAPID_PUBLIC_KEY,
    hasPrivateKey: !!VAPID_PRIVATE_KEY
  });
}

// 仅在配置完整时设置 VAPID
if (VAPID_EMAIL && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${VAPID_EMAIL}`,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

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

async function core(headers) {
  try {
    const h = normalizeHeaders(headers);

    // 0. 验证 VAPID 配置
    if (!VAPID_EMAIL || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return {
        status: 500,
        body: {
          success: false,
          error: {
            code: 'VAPID_CONFIG_ERROR',
            message: 'VAPID 配置缺失，无法发送推送通知',
            details: {
              missingKeys: [
                !VAPID_EMAIL && 'VAPID_EMAIL',
                !VAPID_PUBLIC_KEY && 'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
                !VAPID_PRIVATE_KEY && 'VAPID_PRIVATE_KEY'
              ].filter(Boolean)
            }
          }
        }
      };
    }

    // 1. 验证 Cron Secret
    const authHeader = h['authorization'] || '';
    const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;

    if (authHeader.trim() !== expectedAuth) {
      return {
        status: 401,
        body: {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Cron Secret 验证失败'
          }
        }
      };
    }

    const startTime = Date.now();

    // 2. 查询待处理任务
    /*
    const tasks = await sql`
      SELECT
        id, user_id, uuid, contact_name, avatar_url,
        message_type, message_subtype, user_message,
        next_send_at, recurrence_type,
        api_url, api_key, primary_model, complete_prompt,
        push_subscription, retry_count, metadata
      FROM scheduled_messages
      WHERE status = 'pending'
        AND next_send_at <= NOW()
      ORDER BY next_send_at ASC
      LIMIT 50
    `;
    */

    // 模拟数据库查询结果
    const tasks = []; // 实际项目从数据库获取

    console.log(`[send-notifications] Found ${tasks.length} pending tasks`);

    // 3. 并发处理任务（动态任务池，最大并发 8）
    const MAX_CONCURRENT = 8;
    const results = {
      totalTasks: tasks.length,
      successCount: 0,
      failedCount: 0,
      deletedOnceOffTasks: 0,
      updatedRecurringTasks: 0,
      failedTasks: []
    };

    // 处理单个任务
    async function processTask(task) {
      try {
        console.log('[send-notifications] Processing task:', {
          taskId: task.id,
          contactName: task.contact_name,
          retryCount: task.retry_count
        });

        // 派生用户专属密钥
        const userKey = deriveUserEncryptionKey(task.user_id);

        let messageContent;

        // 根据消息类型生成内容
        if (task.message_type === 'fixed') {
          // 固定消息：直接使用用户消息
          messageContent = decryptFromStorage(task.user_message, userKey);

        } else if (task.message_type === 'prompted' || task.message_type === 'auto') {
          // AI 消息：调用 AI API
          const apiUrl = task.api_url;
          const apiKey = decryptFromStorage(task.api_key, userKey);
          const completePrompt = decryptFromStorage(task.complete_prompt, userKey);

          // 调用 AI API（OpenAI 兼容接口）
          const aiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: task.primary_model,
              messages: [
                {
                  role: 'user',
                  content: completePrompt
                }
              ],
              max_tokens: 500,
              temperature: 0.8
            }),
            signal: AbortSignal.timeout(300000) // 300秒超时
          });

          if (!aiResponse.ok) {
            throw new Error(`AI API error: ${aiResponse.status} ${aiResponse.statusText}`);
          }

          const aiData = await aiResponse.json();
          messageContent = aiData.choices[0].message.content.trim();
        }

        // 消息分句处理（按句号、问号、感叹号分割）
        const sentences = messageContent
          .split(/([。！？!?]+)/)
          .reduce((acc, part, i, arr) => {
            if (i % 2 === 0 && part.trim()) {
              const punctuation = arr[i + 1] || '';
              acc.push(part.trim() + punctuation);
            }
            return acc;
          }, [])
          .filter(s => s.length > 0);

        // 如果没有句子，作为单条消息发送
        const messages = sentences.length > 0 ? sentences : [messageContent];

        // 批量推送通知（消息间添加延迟）
        const pushSubscription = typeof task.push_subscription === 'string'
          ? JSON.parse(task.push_subscription)
          : task.push_subscription;

        for (let i = 0; i < messages.length; i++) {
          const notificationPayload = {
            title: `来自 ${task.contact_name}`,
            message: messages[i],
            contactName: task.contact_name,
            messageId: `msg_${Date.now()}_${task.id}_${i}`,
            messageIndex: i + 1,
            totalMessages: messages.length,
            messageType: task.message_type,
            messageSubtype: task.message_subtype,
            taskId: task.id,
            timestamp: new Date().toISOString(),
            source: 'scheduled',
            avatarUrl: task.avatar_url || null,
            metadata: task.metadata || {}
          };

          await webpush.sendNotification(
            pushSubscription,
            JSON.stringify(notificationPayload)
          );

          console.log('[push] Notification sent:', {
            taskId: task.id,
            messageIndex: i + 1,
            totalMessages: messages.length
          });

          // 消息间延迟（避免过快发送）
          if (i < messages.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }

        // 更新任务状态
        if (task.recurrence_type === 'none') {
          // 一次性任务：删除
          /*
          await sql`
            DELETE FROM scheduled_messages
            WHERE id = ${task.id}
          `;
          */
          results.deletedOnceOffTasks++;

        } else {
          // 循环任务：计算下次发送时间
          let nextSendAt;
          const currentSendAt = new Date(task.next_send_at);

          if (task.recurrence_type === 'daily') {
            nextSendAt = new Date(currentSendAt.getTime() + 24 * 60 * 60 * 1000);
          } else if (task.recurrence_type === 'weekly') {
            nextSendAt = new Date(currentSendAt.getTime() + 7 * 24 * 60 * 60 * 1000);
          }

          /*
          await sql`
            UPDATE scheduled_messages
            SET next_send_at = ${nextSendAt.toISOString()},
                retry_count = 0,
                updated_at = NOW()
            WHERE id = ${task.id}
          `;
          */
          results.updatedRecurringTasks++;
        }

        results.successCount++;

      } catch (error) {
        console.error('[error] Task processing failed:', {
          taskId: task.id,
          errorType: error.name,
          errorMessage: error.message,
          retryCount: task.retry_count
        });

        results.failedCount++;

        // 重试机制
        if (task.retry_count >= 3) {
          // 达到最大重试次数：标记为永久失败
          /*
          await sql`
            UPDATE scheduled_messages
            SET status = 'failed',
                failure_reason = ${error.message},
                updated_at = NOW()
            WHERE id = ${task.id}
          `;
          */

          results.failedTasks.push({
            taskId: task.id,
            reason: error.message,
            retryCount: task.retry_count,
            status: 'permanently_failed'
          });

        } else {
          // 计算下次重试时间（线性递增：2分钟、4分钟、6分钟）
          const nextRetryTime = new Date(Date.now() + (task.retry_count + 1) * 2 * 60 * 1000);

          /*
          await sql`
            UPDATE scheduled_messages
            SET next_send_at = ${nextRetryTime.toISOString()},
                retry_count = ${task.retry_count + 1},
                updated_at = NOW()
            WHERE id = ${task.id}
          `;
          */

          results.failedTasks.push({
            taskId: task.id,
            reason: error.message,
            retryCount: task.retry_count + 1,
            nextRetryAt: nextRetryTime.toISOString()
          });
        }
      }
    }

    // 使用动态任务池处理
    const taskQueue = [...tasks];
    const processing = [];

    while (taskQueue.length > 0 || processing.length > 0) {
      // 填充任务池
      while (processing.length < MAX_CONCURRENT && taskQueue.length > 0) {
        const task = taskQueue.shift();
        const promise = processTask(task);
        processing.push(promise);

        // 清理已完成的 Promise
        promise.finally(() => {
          const index = processing.indexOf(promise);
          if (index > -1) {
            processing.splice(index, 1);
          }
        });
      }

      // 等待任意一个任务完成
      if (processing.length > 0) {
        await Promise.race(processing);
      }
    }

    // 4. 定期清理（删除 7 天前的已完成/失败任务）
    /*
    await sql`
      DELETE FROM scheduled_messages
      WHERE status IN ('sent', 'failed')
        AND updated_at < NOW() - INTERVAL '7 days'
    `;
    */

    const executionTime = Date.now() - startTime;

    console.log('[send-notifications] Processing completed:', {
      totalTasks: results.totalTasks,
      successCount: results.successCount,
      failedCount: results.failedCount,
      executionTime
    });

    // 5. 返回处理结果
    return {
      status: 200,
      body: {
        success: true,
        data: {
          totalTasks: results.totalTasks,
          successCount: results.successCount,
          failedCount: results.failedCount,
          processedAt: new Date().toISOString(),
          executionTime,
          details: {
            deletedOnceOffTasks: results.deletedOnceOffTasks,
            updatedRecurringTasks: results.updatedRecurringTasks,
            failedTasks: results.failedTasks
          }
        }
      }
    };

  } catch (error) {
    console.error('[send-notifications] Fatal error:', error);

    return {
      status: 500,
      body: {
        success: false,
        error: {
          code: 'PROCESSING_ERROR',
          message: '任务处理过程中发生错误',
          details: {
            errorType: error.name,
            errorMessage: error.message
          }
        }
      }
    };
  }
}

module.exports = async function(req, res) {
  try {
    if (req.method !== 'POST') return sendNodeJson(res, 405, { error: 'Method not allowed' });
    const result = await core(req.headers);
    return sendNodeJson(res, result.status, result.body);
  } catch (error) {
    console.error('[send-notifications] Error:', error);
    return sendNodeJson(res, 500, { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: '服务器内部错误，请稍后重试' } });
  }
};

exports.handler = async function(event) {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method not allowed' }) };
    const result = await core(event.headers || {});
    return { statusCode: result.status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(result.body) };
  } catch (error) {
    console.error('[send-notifications] Error:', error);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: '服务器内部错误，请稍后重试' } }) };
  }
};
