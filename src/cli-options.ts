import { PulseError } from './errors.js';

type Values = Readonly<Record<string, string | boolean | undefined>>;
interface Contract {
  options: readonly string[];
  minimum: number;
  maximum: number;
  required?: readonly string[];
}
const dates = ['from', 'to', 'days'];
const selection = ['provider', 'resource', 'group'];
const installation = ['config', 'db'];
const reports = [...installation, ...dates, 'json'];
const contracts: Readonly<Record<string, Contract>> = {
  init: { options: ['config'], minimum: 0, maximum: 0 },
  validate: { options: ['config', 'json'], minimum: 0, maximum: 0 },
  coverage: { options: ['config', 'input', 'json'], minimum: 0, maximum: 0, required: ['input'] },
  connectors: { options: ['json'], minimum: 0, maximum: 0 },
  graph: { options: ['config', 'json'], minimum: 1, maximum: 1 },
  plan: {
    options: ['config', ...selection, ...dates, 'chunk-days', 'max-jobs', 'json'],
    minimum: 0,
    maximum: 0,
  },
  sync: {
    options: [
      ...installation,
      ...selection,
      ...dates,
      'max-jobs',
      'rotate',
      'due-only',
      'dry-run',
      'json',
    ],
    minimum: 0,
    maximum: 0,
  },
  backfill: {
    options: [...installation, ...selection, ...dates, 'chunk-days', 'max-jobs', 'dry-run', 'json'],
    minimum: 0,
    maximum: 0,
    required: ['from', 'to'],
  },
  probe: {
    options: ['config', ...selection, 'from', 'to', 'max-jobs', 'json'],
    minimum: 0,
    maximum: 0,
  },
  inspect: {
    options: [...installation, 'resource', 'input', 'out', 'json'],
    minimum: 0,
    maximum: 0,
    required: ['resource', 'input'],
  },
  doctor: { options: [...installation, 'json'], minimum: 0, maximum: 0 },
  report: { options: [...reports, 'format', 'out'], minimum: 1, maximum: 1 },
  brief: { options: [...reports, 'format', 'out'], minimum: 0, maximum: 1 },
  compare: { options: reports, minimum: 2, maximum: 100 },
  portfolio: { options: reports, minimum: 0, maximum: 0 },
  export: { options: [...installation, 'out'], minimum: 0, maximum: 0, required: ['out'] },
  import: { options: ['db', 'input'], minimum: 0, maximum: 0, required: ['input'] },
  annotate: {
    options: [...installation, 'resource', 'title', 'date'],
    minimum: 0,
    maximum: 0,
    required: ['resource', 'title'],
  },
  compact: { options: installation, minimum: 0, maximum: 0 },
  serve: { options: [...installation, 'port', 'host', 'public-origin'], minimum: 0, maximum: 0 },
  demo: {
    options: ['db', 'serve', 'scenario', 'port', 'host', 'public-origin'],
    minimum: 0,
    maximum: 0,
  },
  visibility: {
    options: ['suite', 'input', 'session', 'out', 'json'],
    minimum: 1,
    maximum: 1,
    required: ['suite'],
  },
};

/** Refuse inputs that would otherwise be silently ignored, before opening private state. */
export function validateCliInput(
  command: string,
  args: readonly string[],
  values: Values,
  optionNames: readonly string[],
): void {
  const contract = Object.hasOwn(contracts, command) ? contracts[command]! : undefined;
  if (!contract) throw new PulseError('CONFIG', 'Unknown command. Run pulse --help.');
  if (args.length < contract.minimum || args.length > contract.maximum)
    throw new PulseError('CONFIG', 'Wrong number of command arguments. Run pulse --help.');
  if (new Set(optionNames).size !== optionNames.length)
    throw new PulseError('CONFIG', 'Each option may be supplied only once.');
  const unsupported = Object.keys(values).find((key) => !contract.options.includes(key));
  if (unsupported)
    throw new PulseError(
      'CONFIG',
      `An option does not apply to ${command}. Supported options: ${contract.options.map((key) => '--' + key).join(', ')}.`,
    );
  if (Object.values(values).some((value) => typeof value === 'string' && value.length === 0))
    throw new PulseError('CONFIG', 'Option values must not be empty.');
  for (const name of contract.required ?? [])
    if (typeof values[name] !== 'string' || values[name] === '')
      throw new PulseError('CONFIG', `This command requires --${name}.`);
  for (const name of ['days', 'max-jobs', 'chunk-days', 'port']) {
    const value = values[name];
    if (
      value !== undefined &&
      (typeof value !== 'string' ||
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) < 1)
    )
      throw new PulseError('CONFIG', 'Numeric options require positive decimal integers.');
  }
  if (values.days !== undefined && (Number(values.days) > 366 || values.from !== undefined))
    throw new PulseError(
      'CONFIG',
      '--days must be between 1 and 366 and cannot combine with --from.',
    );
  if (
    ['report', 'brief', 'compare', 'graph'].includes(command) &&
    args.some((id) => !/^[a-z][a-z0-9_-]{0,63}$/.test(id))
  )
    throw new PulseError('CONFIG', 'Pass valid project identifiers.');
  if (
    command === 'demo' &&
    !values.serve &&
    ['port', 'host', 'public-origin'].some((key) => values[key] !== undefined)
  )
    throw new PulseError('CONFIG', 'Demo server options require --serve.');
  if (command === 'visibility') {
    const action = args[0];
    if (!['template', 'report', 'promptfoo'].includes(action ?? ''))
      throw new PulseError('CONFIG', 'Choose visibility template, report or promptfoo.');
    const needed = action === 'template' ? 'session' : action === 'report' ? 'input' : undefined;
    if (needed && (typeof values[needed] !== 'string' || !values[needed]))
      throw new PulseError('CONFIG', `This visibility action requires --${needed}.`);
    if (['input', 'session'].some((key) => values[key] !== undefined && key !== needed))
      throw new PulseError('CONFIG', 'An input option does not apply to this visibility action.');
  }
}
