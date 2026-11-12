// Short-lived Codex calls for titles, the librarian and other small jobs.
// Reuse the thread adapter's process transport and login, with no persistent
// thread, project instructions or agent tools. Prompts only travel on stdin.
import fs from 'node:fs';
import type { Logger } from '../log.ts';
import type { ProcessRegistry } from '../proc.ts';
import { AppServerProcess, type AppServerTimings } from '../adapters/codex/appserver.ts';
import { isPlainObject } from '../adapters/acp/normalize.ts';
import type { Asker } from './acp-oneshot.ts';
import type { CliResponse } from './claude-pool.ts';

export type CodexAskerDeps = {
  binary: () => string | undefined;
  args?: string[];
  registry: ProcessRegistry;
  log: Logger;
  timings?: Partial<AppServerTimings>;
};

// Enforced after any runner-supplied arguments, before Codex starts, so
// hooks and plugins cannot run while preparing the ephemeral thread.
const OFF = ['hooks', 'plugins', 'apps', 'memories', 'chronicle', 'goals',
  'shell_tool', 'unified_exec', 'shell_snapshot', 'code_mode', 'code_mode_host',
  'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external',
  'computer_use', 'in_app_browser', 'in_app_local_automation', 'image_generation',
  'view_image', 'sleep_tool', 'skill_search'];
export function codexSmallJobArgs(): string[] {
  return [
    ...OFF.flatMap((key) => ['-c', `features.${key}=false`]),
    '-c', 'notify=[]',
    '-c', 'skills.include_instructions=false',
    '-c', 'skills.bundled.enabled=false',
    '-c', 'web_search="disabled"',
    '-c', 'project_doc_max_bytes=0',
    '-c', 'developer_instructions=""',
    '-c', 'tools.update_plan.enabled=false',
    '-c', 'suppress_unstable_features_warning=true',
  ];
}

function failure(message: string, timedOut = false, info?: unknown): CliResponse {
  const kind = typeof info === 'string' ? info : isPlainObject(info) ? Object.keys(info)[0] : '';
  return { ok: false, timedOut, limit: kind === 'usageLimitExceeded' || kind === 'rateLimitExceeded' || /hit your (usage )?limit|usage limit|rate.?limit|\b429\b/i.test(message), message };
}

export function codexAsker(deps: CodexAskerDeps): Asker {
  return async (req) => {
    const binary = deps.binary();
    if (!binary) return failure("Threadbear can't find Codex on this Mac.");
    const proc = new AppServerProcess({ binary, args: [...(deps.args ?? []), ...codexSmallJobArgs()],
      account: req.account, cwd: req.cwd, registry: deps.registry, log: deps.log,
      label: `models:${req.account.id}`, timings: deps.timings });
    let threadId: string | undefined;
    let model = req.model;
    let text = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let settle!: (r: CliResponse) => void;
    const completed = new Promise<CliResponse>((resolve) => { settle = resolve; });
    proc.onExit = (error) => settle(failure(error?.message ?? 'Codex exited without an answer.'));
    // No tools or permission grants, including any future request type.
    proc.onRequest = (id, method) => proc.respondError(id, -32601, `Small jobs cannot call ${method}.`);
    proc.onNotification = (method, params) => {
      if (!isPlainObject(params) || !threadId || params.threadId !== threadId) return;
      if (method === 'item/completed' && isPlainObject(params.item)) {
        const item = params.item;
        if (item.type === 'agentMessage' && typeof item.text === 'string' && item.phase !== 'commentary') text += item.text;
      } else if (method === 'model/rerouted' && typeof params.toModel === 'string') {
        model = params.toModel;
      } else if (method === 'thread/tokenUsage/updated' && isPlainObject(params.tokenUsage)) {
        const usage = isPlainObject(params.tokenUsage.total) ? params.tokenUsage.total : params.tokenUsage.last;
        if (!isPlainObject(usage)) return;
        if (typeof usage.inputTokens === 'number') inputTokens = usage.inputTokens;
        if (typeof usage.outputTokens === 'number') outputTokens = usage.outputTokens;
      } else if (method === 'turn/completed' && isPlainObject(params.turn)) {
        const turn = params.turn;
        const error = isPlainObject(turn.error) ? turn.error : undefined;
        if (turn.status !== 'completed') settle(failure(typeof error?.message === 'string' ? error.message : `Codex stopped (${String(turn.status)}).`, false, error?.codexErrorInfo));
        else settle(text.trim() ? { ok: true, text, model, inputTokens, outputTokens } : failure('Codex completed without an answer.'));
      } else if (method === 'error' && params.willRetry !== true && isPlainObject(params.error)) {
        settle(failure(String(params.error.message ?? 'Codex failed.'), false, params.error.codexErrorInfo));
      }
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      settle(failure(`Codex didn't answer within ${Math.round(req.timeoutMs / 1000)} s.`, true));
    }, req.timeoutMs);
    timer.unref();
    const work = async (): Promise<CliResponse> => {
      fs.mkdirSync(req.cwd, { recursive: true });
      await proc.start();
      if (timedOut) return completed;
      // Empty maps merge with config.toml, so disable every configured MCP
      // entry explicitly. Never log the effective config or keep its values.
      const settings = await proc.request<{ config?: Record<string, unknown> }>('config/read', { includeLayers: false });
      if (!isPlainObject(settings?.config)) return failure('Codex did not return its configuration.');
      const listed = await proc.request<{ data?: { skills?: { name?: string }[]; errors?: unknown[] }[] }>('skills/list', { cwds: [req.cwd], forceReload: true });
      if (!Array.isArray(listed?.data) || listed.data.some((entry) => !Array.isArray(entry.skills) || (entry.errors?.length ?? 0) > 0)) return failure('Codex could not list skills for this small job.');
      const skillNames = [...new Set(listed.data.flatMap((entry) => entry.skills ?? []).map((skill) => skill.name).filter((name): name is string => typeof name === 'string' && name.length > 0))];
      const mcp = settings.config.mcp_servers;
      const config: Record<string, unknown> = { project_doc_max_bytes: 0, developer_instructions: '', model_reasoning_effort: 'low',
        skills: { include_instructions: false, bundled: { enabled: false }, config: skillNames.map((name) => ({ name, enabled: false })) },
      };
      if (isPlainObject(mcp)) {
        // Use a table, so dots in a server name stay literal. Only retain
        // its transport discriminator: config/read's other values can be
        // redacted or serialized differently from config.toml (timeouts).
        config.mcp_servers = Object.fromEntries(Object.entries(mcp).map(([name, server]) => [name, {
          enabled: false,
          ...(isPlainObject(server) && typeof server.url === 'string' ? { url: server.url } : { command: process.execPath }),
        }]));
      }
      const start = await proc.request<{ thread?: { id?: string }; model?: string }>('thread/start', {
        cwd: req.cwd, ...(model ? { model } : {}), ephemeral: true,
        approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only',
        baseInstructions: req.system?.trim() || 'Answer the message. Plain text, no preamble.',
        developerInstructions: '', dynamicTools: [], environments: [], config,
      });
      threadId = start?.thread?.id;
      model = start?.model ?? model;
      if (!threadId) return failure('Codex started a thread without an id.');
      if (timedOut) return completed;
      await proc.request('turn/start', { threadId,
        input: [{ type: 'text', text: req.user, text_elements: [] }],
        effort: 'low', ...(req.jsonSchema ? { outputSchema: req.jsonSchema } : {}),
      });
      return completed;
    };
    try {
      return await Promise.race([work(), completed]);
    } catch (error) {
      return failure((error as Error)?.message ?? String(error), timedOut);
    } finally {
      clearTimeout(timer);
      await proc.close().catch(() => undefined);
    }
  };
}
