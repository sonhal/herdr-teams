export type Kind = 'claude' | 'codex' | 'pi';
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export function adapter(kind: string, model?: string, thinking?: string) {
  if (!['claude', 'codex', 'pi'].includes(kind))
    throw new Error(`Unsupported agent kind: ${kind}`);
  if (thinking && !levels.includes(thinking))
    throw new Error(`Invalid thinking level: ${thinking}`);
  const args: string[] = [];
  if (model) args.push(kind === 'codex' ? '-m' : '--model', model);
  if (thinking) {
    if (kind === 'codex')
      args.push(
        '-c',
        `model_reasoning_effort=${thinking === 'off' ? 'none' : thinking}`,
      );
    else if (kind === 'pi') args.push('--thinking', thinking);
    else
      args.push(
        '--effort',
        ['off', 'minimal', 'low'].includes(thinking)
          ? 'low'
          : thinking === 'xhigh'
            ? 'high'
            : thinking,
      );
  }
  return {
    kind: kind as Kind,
    args,
    exit: kind === 'claude' ? '/exit' : '/quit',
  };
}
