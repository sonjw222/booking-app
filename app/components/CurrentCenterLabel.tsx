"use client";
import { useEffect, useState } from "react";
import { fetchMyCenters, type ManagedCenter } from "../../lib/manager";
import { useCurrentCenterId } from "../../lib/managerCenterSelection";
export default function CurrentCenterLabel() {
  const id = useCurrentCenterId();
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  useEffect(() => { let live = true; fetchMyCenters().then((items) => { if (live) setCenters(items); }).catch(() => {}); return () => { live = false; }; }, [id]);
  const center = centers.find((c) => c.id === id);
  return center ? <div className="current-center-label" aria-live="polite">{center.name} · {center.roleName}</div> : null;
}
