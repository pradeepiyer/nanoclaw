/**
 * Delivery action handlers for scheduling.
 *
 * The container writes a `kind='system'` outbound message with an `action`
 * field. The delivery path reaches into this module via the delivery-action
 * registry and we apply the change via the session mailbox here.
 */
import { wakeContainer } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import {
  withMailboxSession,
  writeSessionMessage,
} from '../../session-manager.js';
import type { Session } from '../../types.js';

export async function handleScheduleTask(
  content: Record<string, unknown>,
  session: Session,
): Promise<void> {
  const taskId = content.taskId as string;
  const prompt = content.prompt as string;
  const script = (content.script as string | null) ?? null;
  const processAfter = content.processAfter as string;
  const recurrence = (content.recurrence as string) || null;

  await withMailboxSession(
    session.agent_group_id,
    session.id,
    async (mailbox) => {
      await mailbox.insertTask({
        id: taskId,
        seriesId: taskId,
        processAfter,
        recurrence,
        content: JSON.stringify({ prompt, script }),
      });
    },
  );
  log.info('Scheduled task created', { taskId, processAfter, recurrence });
}

export async function handleCancelTask(
  content: Record<string, unknown>,
  session: Session,
): Promise<void> {
  const taskId = content.taskId as string;
  await withMailboxSession(session.agent_group_id, session.id, (mailbox) => {
    mailbox.cancelTask(taskId);
  });
  log.info('Task cancelled', { taskId });
}

export async function handlePauseTask(
  content: Record<string, unknown>,
  session: Session,
): Promise<void> {
  const taskId = content.taskId as string;
  await withMailboxSession(session.agent_group_id, session.id, (mailbox) => {
    mailbox.pauseTask(taskId);
  });
  log.info('Task paused', { taskId });
}

export async function handleResumeTask(
  content: Record<string, unknown>,
  session: Session,
): Promise<void> {
  const taskId = content.taskId as string;
  await withMailboxSession(session.agent_group_id, session.id, (mailbox) => {
    mailbox.resumeTask(taskId);
  });
  log.info('Task resumed', { taskId });
}

export async function handleUpdateTask(
  content: Record<string, unknown>,
  session: Session,
): Promise<void> {
  const taskId = content.taskId as string;
  const update: {
    prompt?: string;
    script?: string | null;
    recurrence?: string | null;
    processAfter?: string;
  } = {};
  if (typeof content.prompt === 'string') update.prompt = content.prompt;
  if (typeof content.processAfter === 'string')
    update.processAfter = content.processAfter;
  if (content.recurrence === null || typeof content.recurrence === 'string') {
    update.recurrence = content.recurrence as string | null;
  }
  if (content.script === null || typeof content.script === 'string') {
    update.script = content.script as string | null;
  }

  const touched = await withMailboxSession(
    session.agent_group_id,
    session.id,
    (mailbox) => {
      return mailbox.updateTask(taskId, update);
    },
  );

  log.info('Task updated', { taskId, touched, fields: Object.keys(update) });
  if (touched === 0) {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `update_task: no live task matched id "${taskId}".`,
        sender: 'system',
        senderId: 'system',
      }),
    });
    const fresh = await getSession(session.id);
    if (fresh) {
      wakeContainer(fresh).catch((err) =>
        log.error('Failed to wake container after update_task notification', {
          err,
        }),
      );
    }
  }
}
