#!/usr/bin/env node
// UserPromptSubmit hook：用户消息自带可用问题证据时，注入 direct-evidence 权威标记，
// 让 issue-orchestrator 跳过全部 tracker 步骤。纯文本判定，快、无副作用。
// 附件类信号（截图/日志文件）由 orchestrator 的分流规则兜底。
import { DIRECT_EVIDENCE_MARKER, detectIssueInputMode } from '../scripts/lib/input-detect.mjs'

let raw = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) raw += chunk

let prompt = ''
try { prompt = JSON.parse(raw).prompt ?? '' } catch { /* 非 JSON 输入时静默放行 */ }

if (prompt && detectIssueInputMode(prompt) === 'direct-evidence') {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: DIRECT_EVIDENCE_MARKER,
      },
    }),
  )
}
