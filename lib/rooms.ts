/*
  룸(장소) 관리
  - 센터별 강습 공간 추가/수정/삭제
  - 주소·좌표로 회원 길찾기 지원
  - 2026-10-01: 상세주소(detailAddress) 추가 — 도로명주소(address)와 별개 컬럼
    (rooms.detail_address, add_room_detail_address.sql). 이 마이그레이션이 아직
    실행되지 않은 환경(컬럼 없음, Postgres 42703)에서도 룸 조회/저장 자체가 깨지지
    않도록 select/insert/update 모두 42703을 감지하면 detail_address 없이 한 번
    더 시도한다(이 경우 detailAddress는 null로 취급, 다른 값은 그대로 저장됨).
*/

import { supabase } from "./supabaseClient";

export type Room = {
  id: string;
  centerId: string;
  name: string;
  memo: string | null;
  address: string | null;
  detailAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  sortOrder: number;
};

const MISSING_COLUMN = "42703";

function mapRow(r: any): Room {
  return {
    id: r.id, centerId: r.center_id, name: r.name, memo: r.memo,
    address: r.address, detailAddress: r.detail_address ?? null,
    latitude: r.latitude, longitude: r.longitude, sortOrder: r.sort_order,
  };
}

export async function fetchRooms(centerId: string): Promise<Room[]> {
  const { data, error } = await supabase
    .from("rooms")
    .select("id, center_id, name, memo, address, detail_address, latitude, longitude, sort_order")
    .eq("center_id", centerId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    if (error.code === MISSING_COLUMN) {
      const fallback = await supabase
        .from("rooms")
        .select("id, center_id, name, memo, address, latitude, longitude, sort_order")
        .eq("center_id", centerId)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      if (fallback.error) throw new Error("룸을 불러오지 못했어요: " + fallback.error.message);
      return (fallback.data ?? []).map((r: any) => mapRow({ ...r, detail_address: null }));
    }
    throw new Error("룸을 불러오지 못했어요: " + error.message);
  }
  return (data ?? []).map(mapRow);
}

type RoomInput = {
  name: string;
  memo: string;
  address: string;
  detailAddress: string;
  latitude: number | null;
  longitude: number | null;
};

export async function addRoom(centerId: string, input: RoomInput): Promise<void> {
  const row = {
    center_id: centerId,
    name: input.name,
    memo: input.memo || null,
    address: input.address || null,
    detail_address: input.detailAddress || null,
    latitude: input.latitude,
    longitude: input.longitude,
  };
  const { error } = await supabase.from("rooms").insert(row);
  if (error) {
    if (error.code === MISSING_COLUMN) {
      const { detail_address, ...withoutDetail } = row;
      const retry = await supabase.from("rooms").insert(withoutDetail);
      if (retry.error) throw new Error("룸 추가에 실패했어요: " + retry.error.message);
      return;
    }
    throw new Error("룸 추가에 실패했어요: " + error.message);
  }
}

export async function updateRoom(id: string, input: RoomInput): Promise<void> {
  const row = {
    name: input.name,
    memo: input.memo || null,
    address: input.address || null,
    detail_address: input.detailAddress || null,
    latitude: input.latitude,
    longitude: input.longitude,
  };
  const { error } = await supabase.from("rooms").update(row).eq("id", id);
  if (error) {
    if (error.code === MISSING_COLUMN) {
      const { detail_address, ...withoutDetail } = row;
      const retry = await supabase.from("rooms").update(withoutDetail).eq("id", id);
      if (retry.error) throw new Error("룸 수정에 실패했어요: " + retry.error.message);
      return;
    }
    throw new Error("룸 수정에 실패했어요: " + error.message);
  }
}

export async function deleteRoom(id: string): Promise<void> {
  const { error } = await supabase.from("rooms").delete().eq("id", id);
  if (error) throw new Error("룸 삭제에 실패했어요: " + error.message);
}
