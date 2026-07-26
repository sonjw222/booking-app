/*
  룸(장소) 관리
  - 센터별 강습 공간 추가/수정/삭제
  - 주소·좌표로 회원 길찾기 지원
*/

import { supabase } from "./supabaseClient";

export type Room = {
  id: string;
  centerId: string;
  name: string;
  memo: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  sortOrder: number;
};

export async function fetchRooms(centerId: string): Promise<Room[]> {
  const { data, error } = await supabase
    .from("rooms")
    .select("id, center_id, name, memo, address, latitude, longitude, sort_order")
    .eq("center_id", centerId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error("룸을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => ({
    id: r.id, centerId: r.center_id, name: r.name, memo: r.memo,
    address: r.address, latitude: r.latitude, longitude: r.longitude, sortOrder: r.sort_order,
  }));
}

type RoomInput = { name: string; memo: string; address: string; latitude: number | null; longitude: number | null };

export async function addRoom(centerId: string, input: RoomInput): Promise<void> {
  const { error } = await supabase.from("rooms").insert({
    center_id: centerId,
    name: input.name,
    memo: input.memo || null,
    address: input.address || null,
    latitude: input.latitude,
    longitude: input.longitude,
  });
  if (error) throw new Error("룸 추가에 실패했어요: " + error.message);
}

export async function updateRoom(id: string, input: RoomInput): Promise<void> {
  const { error } = await supabase.from("rooms").update({
    name: input.name,
    memo: input.memo || null,
    address: input.address || null,
    latitude: input.latitude,
    longitude: input.longitude,
  }).eq("id", id);
  if (error) throw new Error("룸 수정에 실패했어요: " + error.message);
}

export async function deleteRoom(id: string): Promise<void> {
  const { error } = await supabase.from("rooms").delete().eq("id", id);
  if (error) throw new Error("룸 삭제에 실패했어요: " + error.message);
}
