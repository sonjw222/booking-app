"use client";

type Item<T extends string> = { value: T; label: string };

export default function SegmentedTabs<T extends string>({ value, items, onChange, label }: {
  value: T;
  items: Item<T>[];
  onChange: (value: T) => void;
  label: string;
}) {
  return <div className="segmented-tabs" role="tablist" aria-label={label}>
    {items.map((item, index) => <button key={item.value} type="button" role="tab" aria-selected={value === item.value}
      tabIndex={value === item.value ? 0 : -1}
      className={value === item.value ? "on" : ""} onClick={() => onChange(item.value)}
      onKeyDown={(event) => {
        let next = index;
        if (event.key === "ArrowRight") next = (index + 1) % items.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = items.length - 1;
        else return;
        event.preventDefault();
        onChange(items[next].value);
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>{item.label}</button>)}
  </div>;
}
