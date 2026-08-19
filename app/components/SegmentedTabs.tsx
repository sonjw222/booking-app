"use client";

type Item<T extends string> = { value: T; label: string };

export default function SegmentedTabs<T extends string>({ value, items, onChange, label }: {
  value: T;
  items: Item<T>[];
  onChange: (value: T) => void;
  label: string;
}) {
  return <div className="segmented-tabs" role="tablist" aria-label={label}>
    {items.map((item) => <button key={item.value} type="button" role="tab" aria-selected={value === item.value}
      className={value === item.value ? "on" : ""} onClick={() => onChange(item.value)}>{item.label}</button>)}
  </div>;
}
