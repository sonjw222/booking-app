/** Snapshot before mutation so cleanup also recovers writes that succeed remotely but reject locally. */
export function temporaryOverrides<T>(read: (id: string) => Promise<T>, write: (id: string, value: T) => Promise<void>) {
  const snapshots = new Map<string, T>();
  return {
    async set(id: string, value: T) {
      if (!snapshots.has(id)) snapshots.set(id, await read(id));
      await write(id, value);
    },
    async restore() {
      const errors: unknown[] = [];
      for (const [id, original] of [...snapshots].reverse()) {
        try { await write(id, original); snapshots.delete(id); }
        catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Permission fixture restoration failed');
    },
  };
}
