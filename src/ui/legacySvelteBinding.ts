type LegacySvelteInternals = {
  props?: Record<string, number | string>;
  bound?: Record<number | string, (value: unknown) => void>;
};

type LegacySvelteInstance = {
  $$?: LegacySvelteInternals;
};

export function bindLegacyExport<T>(
  instance: unknown,
  propName: string,
  onChange: (value: T) => void
): boolean {
  const internals = (instance as LegacySvelteInstance | null | undefined)?.$$;
  const bound = internals?.bound;
  const propIndex = internals?.props?.[propName];

  if (!bound || propIndex === undefined || propIndex === null) {
    return false;
  }

  bound[propIndex] = (value: unknown) => onChange(value as T);
  return true;
}
