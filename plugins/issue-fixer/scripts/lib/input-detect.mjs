// Direct-evidence 输入分流：判断一条用户消息是否自带可用的问题证据，
// 命中时生成注入 prompt 的 `[issue-fixer:direct-evidence]` 权威标记。
// 由 hooks/user-prompt-detect.mjs（UserPromptSubmit）调用；纯文本判定，快、无副作用。

export const DIRECT_EVIDENCE_MARKER = `[issue-fixer:direct-evidence]
用户已在本轮提供可用的问题证据。调用 issue-orchestrator 的 direct-evidence 模式；把本轮文本和附件作为原始证据，跳过 tracker 记录获取、认领和附件下载。不要因为缺少 record/issue id 就列出或查询 tracker。`

const HIGH_CONFIDENCE_PROBLEM = /(?:异常|报错|错误|崩溃|白屏|无反应|没反应|不生效|失败|不对|不正确|不一致|不一样|缺失|没显示|没有显示|错位|遮挡|溢出|截断|太大|太小|过大|过小|bug|broken|error|crash|unresponsive|doesn['’]?t work|not work(?:ing)?|missing|clipped|overflow|misalign)/i
const LOW_CONFIDENCE_PROBLEM = /(?:问题|不能|无法|issue)/i
const FIX_SIGNAL = /(?:修复|修一下|解决|fix|resolve|correct)/i
const ADJUST_SIGNAL = /(?:改一下|改下|改成|调整|优化|处理|应该|期望|adjust)/i
const PRODUCT_UI_CONTEXT = /(?:页面|界面|按钮|弹窗|组件|文案|设计稿|样式|布局|交互|间距|高度|宽度|banner|dialog|modal|button|component|\b\d+(?:\.\d+)?(?:px|rem|vh|vw)\b)/i
const STRUCTURED_DIAGNOSTIC = /(?:\b(?:runId|logid)\s*[:：=]|(?:Type|Reference|Range|Syntax)Error\s*:|\bHTTP\s*[45]\d\d\b|\b[45]\d\d\s+(?:error|response)\b|(?:复现步骤|复现路径|steps? to reproduce|repro(?:duction)? steps?)\s*[:：]|\n\s*at\s+\S+[:(]\d+)/i
const ERROR_DETAIL = /(?:cannot read|undefined|null is not|exception|timed?\s*out|stack trace)/i
const NUMBERED_REPRO = /(?:^|\n)\s*1[.)、][\s\S]*\n\s*2[.)、]/i
const DIAGNOSTIC_FILE = /\.(?:log|trace|har|stacktrace)(?:\?.*)?$/i
// 显式 tracker/工单输入：不注入 direct-evidence 标记，交给 issue-orchestrator 分流。
// 覆盖本仓内置 tracker 形态（lark-base 记录与 /base/ 链接）与通用 issue/work-item 链接。
const EXPLICIT_TRACKER_INPUT = /(?:\/fix-(?:base-)?issue\b|\/fix-workitem\b|(?:^|\s)rec[a-z0-9]{6,}\b|[?&](?:record|record_id)=rec[a-z0-9]+|https?:\/\/\S+\/base\/|多维表格|\bBase\s*(?:record|记录)|https?:\/\/\S+\/(?:issues|workitems?|work_items?)\/\d+|meego(?:le)?\.\S+)/i
const EXPLANATION_INTENT = /(?:什么意思|解释|说明一下|总结|分析一下|发生了什么|what does|explain|summari[sz]e)/i

export function detectIssueInputMode(text, attachments = []) {
  const message = String(text ?? '').trim()
  if (EXPLICIT_TRACKER_INPUT.test(message)) return undefined
  if (EXPLANATION_INTENT.test(message) && !FIX_SIGNAL.test(message)) return undefined
  if (STRUCTURED_DIAGNOSTIC.test(message)) return 'direct-evidence'
  const hasHighConfidenceProblem = HIGH_CONFIDENCE_PROBLEM.test(message)
  const hasLowConfidenceProblem = LOW_CONFIDENCE_PROBLEM.test(message)
  const hasFixIntent = FIX_SIGNAL.test(message)
  const hasAdjustIntent = ADJUST_SIGNAL.test(message)
  const hasProductContext = PRODUCT_UI_CONTEXT.test(message)
  const hasErrorDetail = ERROR_DETAIL.test(message)
  const hasDiagnosticFile = attachments.some(
    (attachment) => attachment.kind === 'file' && DIAGNOSTIC_FILE.test(attachment.name ?? attachment.url ?? ''),
  )

  if (NUMBERED_REPRO.test(message) && (hasHighConfidenceProblem || hasLowConfidenceProblem || hasFixIntent || hasProductContext)) {
    return 'direct-evidence'
  }
  if (hasDiagnosticFile && (hasHighConfidenceProblem || hasLowConfidenceProblem || hasFixIntent || hasErrorDetail)) {
    return 'direct-evidence'
  }

  const hasImage = attachments.some((attachment) => attachment.kind === 'image')
  if (!hasImage) {
    if (hasHighConfidenceProblem && (hasProductContext || hasFixIntent || hasErrorDetail)) return 'direct-evidence'
    return hasLowConfidenceProblem && (hasProductContext || hasFixIntent) ? 'direct-evidence' : undefined
  }

  if (hasHighConfidenceProblem) return 'direct-evidence'
  if (hasLowConfidenceProblem && (hasProductContext || hasFixIntent)) return 'direct-evidence'
  return hasProductContext && (hasFixIntent || hasAdjustIntent)
    ? 'direct-evidence'
    : undefined
}

export function buildPrompt(text, attachments = []) {
  const links = attachments
    .filter((attachment) => attachment.kind === 'file')
    .map((attachment) => `[${attachment.name}](${attachment.url})`)
  const routingHint = detectIssueInputMode(text, attachments) === 'direct-evidence'
    ? DIRECT_EVIDENCE_MARKER
    : undefined
  return [routingHint, text, ...links].filter(Boolean).join('\n\n')
}
