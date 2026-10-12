// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
vi.mock('../../app/components/UiIcon', () => ({ default: () => null }));
import MonthPicker from '../../app/components/MonthPicker';
vi.stubGlobal('React', React); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
it('portals outside clipping ancestors, selects a month, and closes on Escape without closing the sheet', async () => {
  const host = document.createElement('div'); host.style.overflow = 'hidden'; document.body.append(host);
  const root = createRoot(host); const change = vi.fn();
  try {
    await act(() => root.render(React.createElement(MonthPicker, {value: '2026-10', onChange: change})));
    const trigger = host.querySelector('button')!;
    await act(() => trigger.click());
    const dialog = document.querySelector('[role=dialog]')!;
    expect(dialog.parentElement).toBe(document.body); expect(host.contains(dialog)).toBe(false);
    await act(() => [...dialog.querySelectorAll('button')].find(b => b.textContent === '11월')!.click());
    expect(change).toHaveBeenCalledWith('2026-11'); expect(document.querySelector('[role=dialog]')).toBeNull();
    await act(() => trigger.click());
    const bubble = vi.fn(); document.addEventListener('keydown', bubble);
    await act(() => document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})));
    document.removeEventListener('keydown',bubble);
    expect(bubble).not.toHaveBeenCalled(); expect(document.activeElement).toBe(trigger);
  } finally { await act(() => root.unmount()); host.remove(); }
});
