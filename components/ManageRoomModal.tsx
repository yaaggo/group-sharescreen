"use client";

import { useEffect, useState, useMemo, type ComponentType } from "react";
import {
  MIN_ROOM_MEMBER_LIMIT,
  MAX_ROOM_MEMBER_LIMIT,
} from "@/lib/roomLimits";
import { BsGearFill } from "react-icons/bs";
import { FaCrown, FaBan } from "react-icons/fa";
import {
  MdGavel,
  MdGroups,
  MdOutlineOndemandVideo,
  MdChevronRight,
  MdArrowBack,
  MdOutlineChat,
  MdGif,
  MdOutlineMap,
  MdPeopleAlt,
  MdPersonRemove,
  MdBlock,
  MdMicOff,
  MdMic,
  MdOutlineCheckCircle,
  MdSearch,
  MdClose,
  MdSecurity,
} from "react-icons/md";
import {
  signalingClient,
  type RoomPermissionKey,
  type PeerInfo,
  type RoomLocation,
  type RoomBan,
} from "@/lib/signalingClient";
import { useSignaling } from "@/lib/useSignaling";
import { DisplayUserName } from "./DisplayUserName";
import { WorldMap } from "./WorldMap";
import { usePublicRoomMarkers } from "@/lib/usePublicRoomMarkers";
import { MicIcon, ScreenIcon, CameraIcon } from "./icons";
import { Tooltip } from "./Tooltip";
import Link from "next/link";

// The room-level switches, in the order they're shown. Each label is phrased
// as what it *permits*, so it reads true when the toggle is on — and the note
// above the list spells out what turning one off actually does, since "off"
// here never means "nobody", only "owner and admins".
const PERMISSION_ROWS: {
  key: RoomPermissionKey;
  label: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { key: "mic", label: "Permitir que todos liguem o microfone", icon: MicIcon },
  { key: "screen", label: "Permitir que todos compartilhem sua tela", icon: ScreenIcon },
  { key: "camera", label: "Permitir que todos liguem sua câmera", icon: CameraIcon },
  {
    key: "videoSource",
    label: "Permitir que todos adicionem uma fonte de vídeo",
    icon: MdOutlineOndemandVideo,
  },
  { key: "chat", label: "Permitir que todos enviem mensagens no chat", icon: MdOutlineChat },
  { key: "gif", label: "Permitir que todos enviem GIFS", icon: MdGif },
];

type View = "menu" | "members" | "admins" | "permissions" | "location" | "limit" | "bans";
type MembersTab = "active" | "banned";

// Rounded for display only — the full precision is what gets sent. Six
// decimals is roughly a tenth of a metre, far past anything a click on a
// world map means, so anything longer is just noise in a readout.
function formatCoordinate(value: number): string {
  return value.toFixed(4);
}

function formatBanDate(timestamp: number): string {
  try {
    const date = new Date(timestamp);
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return "";
  }
}

// The popup behind the "Gerenciar sala" button above the chat (see
// WatchRoom.tsx) — an ntpopups popup type, registered as "manage_room" in
// NtPopups.tsx, same pattern as AddVideoSourceModal.
export type ManageRoomPopupData = {
  // Which screen to open on. WatchRoom's "Local no mapa" button opens this
  // same popup straight on "location" (see openRoomLocationPopup there),
  // which is why that one has no entry in the menu below — the button *is*
  // the entry.
  initialView?: View;
  // False for the read-only "where is this room" view every participant can
  // open — the map, the pin and the search box, minus the ability to move it.
  // The owner/admin check itself lives in WatchRoom (it decides which button
  // to render); this only says which of the two was pressed, and the server
  // refuses a move from anyone else regardless.
  canEdit?: boolean;
  // Opened by itself the moment someone's join created a public room (see
  // WatchRoom), rather than by pressing a button. Same location view, but
  // introduced as the congratulation it is: a brand-new room is exactly when
  // putting it on the map is worth something, and the moment its owner is
  // most likely to bother.
  justCreated?: boolean;
};

export function ManageRoomModal({
  closePopup,
  data,
}: {
  closePopup: (hasAction?: boolean) => void;
  data?: ManageRoomPopupData;
}) {
  const state = useSignaling();
  const [view, setView] = useState<View>(data?.initialView ?? "menu");
  const [membersTab, setMembersTab] = useState<MembersTab>("active");
  const [memberSearch, setMemberSearch] = useState("");
  const [banTarget, setBanTarget] = useState<{ userId: string; name: string } | null>(null);
  const [banReason, setBanReason] = useState("");
  const [kickTarget, setKickTarget] = useState<{ userId: string; name: string } | null>(null);

  // Where the pin currently sits in the "Definir local do mundo" view —
  // local until "Salvar local", so a stray click on the map doesn't move the
  // room out from under everyone mid-drag. Seeded once, from wherever the
  // room already is, rather than synced continuously: it *is* the unsaved
  // edit, and the popup is opened straight onto this view (see
  // WatchRoom's openRoomLocationPopup) so there is no later moment to seed it.
  const [pick, setPick] = useState<RoomLocation | null>(state.roomLocation);
  // Seeded once from the room's current limit, and left alone after: it is the
  // unsaved edit, and re-syncing it while somebody types would fight them.
  const [limitInput, setLimitInput] = useState(
    state.roomMemberLimit === null ? "" : String(state.roomMemberLimit)
  );
  // The rooms already on the map, drawn under the pin being placed. Someone
  // choosing a spot is choosing it *relative to* other rooms — and an owner
  // looking at an empty globe has no reason to think anyone would ever find
  // them there. This room itself is left out: it is the `pick` pin.
  const { markers } = usePublicRoomMarkers({ excludeHandle: state.room ?? undefined });

  const isOwner = Boolean(state.selfUserId && state.roomOwnerId === state.selfUserId);
  const isManager = isOwner || state.roomAdmins.some((a) => a.id === state.selfUserId);
  // Admins may flip the permission switches and moderate regular members,
  // but cannot promote/demote admins — that stays the owner's alone.
  const canManageAdmins = isOwner;

  // Moderators ride the peer list so their WebRTC connections get set up, but
  // are invisible to real participants — they must not show up here.
  const promotablePeers = useMemo(() => {
    return state.peers.filter(
      (p): p is PeerInfo & { userId: string } =>
        p.role !== "moderator" && Boolean(p.userId) && p.userId !== state.roomOwnerId
    );
  }, [state.peers, state.roomOwnerId]);

  // Active room peers for moderation (excluding self and moderators)
  const moderatablePeers = useMemo(() => {
    return state.peers.filter(
      (p) => p.role !== "moderator" && Boolean(p.userId) && p.userId !== state.selfUserId
    );
  }, [state.peers, state.selfUserId]);

  // Filtered lists based on search
  const filteredPeers = useMemo(() => {
    const query = memberSearch.trim().toLowerCase();
    if (!query) return moderatablePeers;
    return moderatablePeers.filter((p) => p.name.toLowerCase().includes(query));
  }, [moderatablePeers, memberSearch]);

  const allBannedList: RoomBan[] = useMemo(() => {
    if (state.roomBans && state.roomBans.length > 0) {
      return state.roomBans;
    }
    return state.roomBannedMembers.map((b) => ({
      id: b.id,
      name: b.name,
      bannedAt: b.bannedAt,
      reason: b.reason,
    }));
  }, [state.roomBans, state.roomBannedMembers]);

  const filteredBannedMembers = useMemo(() => {
    const query = memberSearch.trim().toLowerCase();
    if (!query) return allBannedList;
    return allBannedList.filter(
      (b) => b.name.toLowerCase().includes(query) || b.id.toLowerCase().includes(query)
    );
  }, [allBannedList, memberSearch]);

  // Asked for rather than pushed on join: most managers never open this, and
  // who a room banned is not something the room at large is told (see the
  // server's sendRoomBansToManagers). Re-asked on entering the tab, so a list
  // left open through a reconnect is not a stale one.
  useEffect(() => {
    if (view === "members" || view === "bans") signalingClient.requestRoomBans();
  }, [view]);

  const saved = state.roomLocation;
  const pinMoved = pick?.lat !== saved?.lat || pick?.lng !== saved?.lng;
  const canEditLocation = (data?.canEdit ?? true) && isManager;
  // Only ever the celebration when there is genuinely something to celebrate
  // *and* to act on: whoever cannot move the pin has nothing to do here.
  const celebrating = Boolean(data?.justCreated) && canEditLocation;

  const title =
    view === "members"
      ? "Gerenciar membros"
      : view === "admins"
        ? "Gerenciar administradores"
        : view === "permissions"
          ? "Gerenciar permissões"
          : view === "limit"
            ? "Limite de participantes"
            : view === "bans"
              ? "Banimentos"
              : view === "location"
                ? celebrating
                  ? "Você criou uma sala pública!"
                  : canEditLocation
                    ? "Definir local do mundo"
                    : "Local da sala no mundo"
                : "Gerenciar sala";

  // Permission check helper for moderating a specific user
  function canModerateUser(targetUserId?: string, targetIsAdmin = false): boolean {
    if (!targetUserId || !isManager) return false;
    if (targetUserId === state.selfUserId) return false;
    if (targetUserId === state.roomOwnerId) return false;
    if (targetIsAdmin && !isOwner) return false;
    return true;
  }

  function handleConfirmBan() {
    if (!banTarget) return;
    signalingClient.banRoomMember(banTarget.userId, banTarget.name, banReason.trim() || undefined);
    setBanTarget(null);
    setBanReason("");
  }

  function handleConfirmKick() {
    if (!kickTarget) return;
    signalingClient.kickRoomMember(kickTarget.userId);
    setKickTarget(null);
  }

  return (
    <div
      className={`flex max-h-[92vh] max-w-full flex-col gap-4 overflow-y-auto bg-white p-5 text-zinc-900 shadow-2xl transition-all dark:bg-zinc-950 dark:text-zinc-50 ${
        view === "location" ? "w-full" : "w-full max-w-lg sm:w-[32rem]"
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-200 pb-3 dark:border-zinc-800">
        <div className="flex min-w-0 items-center gap-2">
          {view !== "menu" && data?.initialView === undefined && (
            <button
              type="button"
              onClick={() => {
                setView("menu");
                setBanTarget(null);
                setKickTarget(null);
                setMemberSearch("");
              }}
              aria-label="Voltar"
              className="-ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <MdArrowBack className="h-4 w-4" />
            </button>
          )}
          <div className="flex min-w-0 items-center gap-2 truncate">
            {view === "members" ? (
              <MdPeopleAlt className="h-4.5 w-4.5 shrink-0 text-zinc-600 dark:text-zinc-300" />
            ) : view === "admins" ? (
              <FaCrown className="h-4 w-4 shrink-0 text-amber-500" />
            ) : view === "permissions" ? (
              <MdSecurity className="h-4.5 w-4.5 shrink-0 text-zinc-600 dark:text-zinc-300" />
            ) : celebrating ? (
              <MdOutlineMap className="h-4.5 w-4.5 shrink-0 text-sky-500" />
            ) : (
              <BsGearFill className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" />
            )}
            <h1 className="truncate text-sm font-semibold tracking-tight">{title}</h1>
          </div>
        </div>
        <button
          type="button"
          onClick={() => closePopup(false)}
          aria-label="Fechar"
          className="-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-lg leading-none opacity-60 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
        >
          ×
        </button>
      </div>

      {/* Main Menu */}
      {view === "menu" && (
        <div className="flex flex-col gap-2.5 pt-1">
          {/* Gerenciar Membros Option */}
          <button
            type="button"
            onClick={() => {
              setView("members");
              setMembersTab("active");
            }}
            className="group flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-3 text-left transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-700 transition group-hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:group-hover:bg-zinc-700">
                <MdPeopleAlt className="h-4.5 w-4.5" />
              </div>
              <div className="flex flex-col">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    Gerenciar membros
                  </span>
                  {state.roomBannedMembers.length > 0 && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-600 dark:bg-red-950/60 dark:text-red-400">
                      {state.roomBannedMembers.length} banido{state.roomBannedMembers.length > 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  Expulsar, banir, desbanir ou mutar participantes
                </span>
              </div>
            </div>
            <MdChevronRight className="h-5 w-5 shrink-0 text-zinc-400 transition group-hover:translate-x-0.5 group-hover:text-zinc-700 dark:text-zinc-500 dark:group-hover:text-zinc-300" />
          </button>

          {/* Gerenciar Administradores Option */}
          {canManageAdmins && (
            <button
              type="button"
              onClick={() => setView("admins")}
              className="group flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-3 text-left transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-700 transition group-hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:group-hover:bg-zinc-700">
                  <FaCrown className="h-4 w-4" />
                </div>
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      Gerenciar administradores
                    </span>
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      {state.roomAdmins.length}
                    </span>
                  </div>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    Promover ou remover administradores da sala
                  </span>
                </div>
              </div>
              <MdChevronRight className="h-5 w-5 shrink-0 text-zinc-400 transition group-hover:translate-x-0.5 group-hover:text-zinc-700 dark:text-zinc-500 dark:group-hover:text-zinc-300" />
            </button>
          )}

          {/* Gerenciar Permissões Option */}
          <button
            type="button"
            onClick={() => setView("limit")}
            className="flex items-center justify-between gap-2 rounded-lg border border-zinc-300 px-3 py-2.5 text-left text-sm font-medium transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            <span className="flex items-center gap-2">
              <MdGroups className="h-4 w-4 shrink-0 text-sky-500" />
              Limite de participantes
            </span>
            <span className="flex items-center gap-1 text-xs font-normal text-zinc-500 dark:text-zinc-400">
              {state.roomMemberLimit ?? "sem limite"}
              <MdChevronRight className="h-4 w-4 shrink-0 opacity-50" />
            </span>
          </button>
          {canManageAdmins && (
            <button
              type="button"
              onClick={() => setView("bans")}
              className="flex items-center justify-between gap-2 rounded-lg border border-zinc-300 px-3 py-2.5 text-left text-sm font-medium transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              <span className="flex items-center gap-2">
                <MdGavel className="h-4 w-4 shrink-0 text-red-500" />
                Banimentos
              </span>
              <MdChevronRight className="h-4 w-4 shrink-0 opacity-50" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setView("permissions")}
            className="group flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-3 text-left transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-700 transition group-hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:group-hover:bg-zinc-700">
                <MdSecurity className="h-4.5 w-4.5" />
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Gerenciar permissões
                </span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  Controle de microfone, transmissão, câmera e chat
                </span>
              </div>
            </div>
            <MdChevronRight className="h-5 w-5 shrink-0 text-zinc-400 transition group-hover:translate-x-0.5 group-hover:text-zinc-700 dark:text-zinc-500 dark:group-hover:text-zinc-300" />
          </button>

          {!canManageAdmins && (
            <p className="mt-2 text-center text-xs text-zinc-500 dark:text-zinc-400">
              Apenas o dono da sala pode nomear novos administradores.
            </p>
          )}
        </div>
      )}

      {/* View: Members (Active + Banned) */}
      {view === "members" && (
        <div className="flex flex-col gap-4">
          {/* Sub-tabs */}
          <div className="flex rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
            <button
              type="button"
              onClick={() => {
                setMembersTab("active");
                setBanTarget(null);
                setKickTarget(null);
              }}
              className={`flex flex-1 items-center justify-center gap-2 rounded-md py-1.5 text-xs font-medium transition ${
                membersTab === "active"
                  ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
            >
              <span>Na sala</span>
              <span className="rounded-full bg-zinc-200 px-1.5 py-0.2 text-[10px] dark:bg-zinc-700">
                {moderatablePeers.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setMembersTab("banned");
                setBanTarget(null);
                setKickTarget(null);
              }}
              className={`flex flex-1 items-center justify-center gap-2 rounded-md py-1.5 text-xs font-medium transition ${
                membersTab === "banned"
                  ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
            >
              <span>Banidos</span>
              <span
                className={`rounded-full px-1.5 py-0.2 text-[10px] ${
                  state.roomBannedMembers.length > 0
                    ? "bg-red-100 text-red-600 dark:bg-red-950/80 dark:text-red-400"
                    : "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
                }`}
              >
                {state.roomBannedMembers.length}
              </span>
            </button>
          </div>

          {/* Search bar */}
          <div className="relative">
            <MdSearch className="absolute left-3 top-2.5 h-4 w-4 text-zinc-400" />
            <input
              type="text"
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder={membersTab === "active" ? "Buscar participantes..." : "Buscar banidos..."}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50/50 py-2 pl-9 pr-3 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-100 dark:placeholder:text-zinc-500"
            />
            {memberSearch && (
              <button
                type="button"
                onClick={() => setMemberSearch("")}
                className="absolute right-2.5 top-2.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                <MdClose className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Ban Confirmation Modal Dialog */}
          {banTarget && (
            <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center gap-2 text-zinc-900 dark:text-zinc-100">
                <FaBan className="h-4 w-4 shrink-0 text-red-500" />
                <h3 className="text-sm font-semibold">Banir {banTarget.name}?</h3>
              </div>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                Este participante será expulso imediatamente e impedido de entrar novamente nesta sala.
              </p>
              <input
                type="text"
                maxLength={80}
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                placeholder="Motivo do banimento (opcional)"
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs text-zinc-900 placeholder:text-zinc-400 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              />
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setBanTarget(null);
                    setBanReason("");
                  }}
                  className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleConfirmBan}
                  className="rounded-lg bg-red-600 px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-red-500"
                >
                  Confirmar Banimento
                </button>
              </div>
            </div>
          )}

          {/* Kick Confirmation Modal Dialog */}
          {kickTarget && (
            <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center gap-2 text-zinc-900 dark:text-zinc-100">
                <MdPersonRemove className="h-4.5 w-4.5 shrink-0 text-amber-500" />
                <h3 className="text-sm font-semibold">Expulsar {kickTarget.name}?</h3>
              </div>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                O participante será removido da sala atual, mas poderá retornar quando desejar.
              </p>
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setKickTarget(null)}
                  className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleConfirmKick}
                  className="rounded-lg bg-amber-600 px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-amber-500"
                >
                  Confirmar Expulsão
                </button>
              </div>
            </div>
          )}

          {/* Tab 1: Active Participants in room */}
          {membersTab === "active" && !banTarget && !kickTarget && (
            <div className="flex flex-col gap-2">
              {filteredPeers.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-200 py-8 text-center dark:border-zinc-800">
                  <MdPeopleAlt className="mb-2 h-8 w-8 text-zinc-300 dark:text-zinc-700" />
                  <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    {memberSearch
                      ? "Nenhum participante encontrado para a busca."
                      : "Nenhum outro participante na sala."}
                  </p>
                </div>
              ) : (
                <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-0.5">
                  {filteredPeers.map((peer) => {
                    const peerIsAdmin = state.roomAdmins.some((a) => a.id === peer.userId);
                    const peerIsOwner = peer.userId === state.roomOwnerId;
                    const isMuted = Boolean(peer.userId && state.roomMutedMembers.includes(peer.userId));
                    const canModerate = canModerateUser(peer.userId, peerIsAdmin);

                    return (
                      <li
                        key={peer.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900/40"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <DisplayUserName
                            name={peer.name}
                            isGuest={peer.isGuest}
                            verified={peer.flags?.includes("VERIFIED")}
                            className="truncate text-xs font-medium"
                          />
                          {peerIsOwner ? (
                            <Tooltip content="Dono da sala">
                              <span className="flex shrink-0 items-center">
                                <FaCrown className="h-3 w-3 text-amber-500" />
                              </span>
                            </Tooltip>
                          ) : (
                            peerIsAdmin && (
                              <Tooltip content="Administrador">
                                <span className="flex shrink-0 items-center">
                                  <FaCrown className="h-3 w-3 text-zinc-400 dark:text-zinc-500" />
                                </span>
                              </Tooltip>
                            )
                          )}
                          {isMuted && (
                            <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:bg-red-950/70 dark:text-red-400">
                              Mudo
                            </span>
                          )}
                        </div>

                        {canModerate ? (
                          <div className="flex shrink-0 items-center gap-1.5">
                            {/* Mute/Unmute toggle */}
                            <Tooltip content={isMuted ? "Desmutar microfone" : "Mutar microfone na sala"}>
                              <button
                                type="button"
                                onClick={() => {
                                  if (peer.userId) {
                                    signalingClient.setRoomMemberMute(peer.userId, !isMuted);
                                  }
                                }}
                                className={`flex h-7 w-7 items-center justify-center rounded-lg border transition ${
                                  isMuted
                                    ? "border-red-300 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/60 dark:text-red-400"
                                    : "border-zinc-200 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                }`}
                              >
                                {isMuted ? <MdMicOff className="h-3.5 w-3.5" /> : <MdMic className="h-3.5 w-3.5" />}
                              </button>
                            </Tooltip>

                            {/* Kick button */}
                            <Tooltip content="Expulsar da sala">
                              <button
                                type="button"
                                onClick={() => {
                                  if (peer.userId) {
                                    setKickTarget({ userId: peer.userId, name: peer.name });
                                  }
                                }}
                                className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-200 text-zinc-600 transition hover:border-amber-300 hover:bg-amber-50 hover:text-amber-600 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-amber-900/60 dark:hover:bg-amber-950/40 dark:hover:text-amber-400"
                              >
                                <MdPersonRemove className="h-3.5 w-3.5" />
                              </button>
                            </Tooltip>

                            {/* Ban button */}
                            <Tooltip content="Banir da sala">
                              <button
                                type="button"
                                onClick={() => {
                                  if (peer.userId) {
                                    setBanTarget({ userId: peer.userId, name: peer.name });
                                    setBanReason("");
                                  }
                                }}
                                className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-200 text-zinc-600 transition hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-red-900/60 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                              >
                                <MdBlock className="h-3.5 w-3.5" />
                              </button>
                            </Tooltip>
                          </div>
                        ) : (
                          <span className="text-[11px] italic text-zinc-400">Protegido</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {/* Tab 2: Banned Members List */}
          {membersTab === "banned" && !banTarget && !kickTarget && (
            <div className="flex flex-col gap-2">
              {filteredBannedMembers.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-200 py-8 text-center dark:border-zinc-800">
                  <MdOutlineCheckCircle className="mb-2 h-8 w-8 text-zinc-300 dark:text-zinc-700" />
                  <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    {memberSearch
                      ? "Nenhum membro banido encontrado para a busca."
                      : "Nenhum membro está banido nesta sala."}
                  </p>
                </div>
              ) : (
                <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-0.5">
                  {filteredBannedMembers.map((banned) => (
                    <li
                      key={banned.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900/40"
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
                          {banned.name}
                        </span>
                        <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                          <span>Banido em {formatBanDate(banned.bannedAt)}</span>
                          {banned.reason && (
                            <span className="truncate italic text-zinc-600 dark:text-zinc-300">
                              • &quot;{banned.reason}&quot;
                            </span>
                          )}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => signalingClient.unbanRoomMember(banned.id)}
                        className="flex shrink-0 items-center gap-1 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      >
                        <MdOutlineCheckCircle className="h-3.5 w-3.5" />
                        Desbanir
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* View: Admins */}
      {view === "admins" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Administradores atuais ({state.roomAdmins.length})
            </p>
            {state.roomAdmins.length === 0 ? (
              <p className="rounded-lg bg-zinc-50 p-3 text-xs text-zinc-500 dark:bg-zinc-900/50 dark:text-zinc-400">
                Nenhum administrador adicional nomeado. Administradores podem moderar membros e
                ajustar regras da sala.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {state.roomAdmins.map((admin) => {
                  const live = state.peers.find((p) => p.userId === admin.id);
                  return (
                    <li
                      key={admin.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white p-2.5 text-xs dark:border-zinc-800 dark:bg-zinc-900/40"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <FaCrown className="h-3 w-3 shrink-0 text-amber-500" />
                        <DisplayUserName
                          name={live?.name || admin.name || "Participante"}
                          isGuest={live?.isGuest}
                          verified={live?.flags?.includes("VERIFIED")}
                          className="truncate font-medium"
                        />
                        {!live && (
                          <span className="shrink-0 text-[10px] text-zinc-400 dark:text-zinc-500">
                            (ausente)
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => signalingClient.removeRoomAdmin(admin.id)}
                        className="shrink-0 rounded-lg border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                      >
                        Remover
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Promover participantes
            </p>
            {promotablePeers.length === 0 ? (
              <p className="rounded-lg bg-zinc-50 p-3 text-xs text-zinc-500 dark:bg-zinc-900/50 dark:text-zinc-400">
                Não há outros participantes na sala para promover.
              </p>
            ) : (
              <ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
                {promotablePeers.map((peer) => {
                  const alreadyAdmin = state.roomAdmins.some((a) => a.id === peer.userId);
                  return (
                    <li
                      key={peer.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white p-2.5 text-xs dark:border-zinc-800 dark:bg-zinc-900/40"
                    >
                      <DisplayUserName
                        name={peer.name}
                        isGuest={peer.isGuest}
                        verified={peer.flags?.includes("VERIFIED")}
                        className="truncate font-medium"
                      />
                      <button
                        type="button"
                        disabled={alreadyAdmin}
                        onClick={() => signalingClient.addRoomAdmin(peer.userId)}
                        className="shrink-0 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      >
                        {alreadyAdmin ? "Já é admin" : "Tornar admin"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* View: Location */}
      {view === "location" && (
        <div className="flex flex-col gap-3">
          <p
            className={
              celebrating
                ? "text-sm leading-relaxed text-zinc-600 dark:text-zinc-300"
                : "text-xs text-zinc-500 dark:text-zinc-400"
            }
          >
            {celebrating ? (
              <>
                Sua sala já está no ar e aparece na lista de{" "}
                <Link style={{ color: "#25baff" }} href="/rooms" target="_blank">
                  salas públicas
                </Link>
                . Marque no mapa abaixo de onde ela é — bairro, cidade ou país, o quanto você
                quiser dizer — e ela também passa a aparecer no{" "}
                <Link style={{ color: "#25baff" }} href="/worldmap" target="_blank">
                  mapa de salas
                </Link>
                , onde quem está perto de você encontra ela primeiro. Dá para mudar ou tirar do
                mapa quando quiser.
              </>
            ) : canEditLocation ? (
              <>
                Defina um lugar para que a sala fique visível no{" "}
                <Link style={{ color: "#25baff" }} href={"/worldmap"} target="_blank">
                  mapa de salas
                </Link>
                . Pessoas que moram perto podem começar a aparecer.
              </>
            ) : (
              <>
                Onde o dono da sala colocou ela no{" "}
                <span className="font-medium">mapa de salas</span>. Só o dono e os administradores
                podem mudar.
              </>
            )}
          </p>

          <div className="h-[min(60vh,32rem)] min-h-64 overflow-hidden rounded-xl border border-zinc-300 shadow-inner dark:border-zinc-800">
            <WorldMap
              className="h-full w-full"
              searchable
              // The rooms already placed, so the globe isn't empty and the
              // spot being picked has some context around it.
              markers={markers}
              pick={pick}
              onPick={canEditLocation ? (lat, lng) => setPick({ lat, lng }) : undefined}
              center={pick ? [pick.lat, pick.lng] : undefined}
              zoom={pick ? 6 : undefined}
            />
          </div>

          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {markers.length > 0 && (
              <>
                <span className="font-medium text-zinc-600 dark:text-zinc-300">
                  {markers.length}{" "}
                  {markers.length === 1 ? "outra sala já está" : "outras salas já estão"} no mapa
                </span>
                {" · "}
              </>
            )}
            {pick ? (
              <>
                {canEditLocation ? "Alfinete em" : "Sala em"}{" "}
                <span className="font-mono text-zinc-700 dark:text-zinc-300">
                  {formatCoordinate(pick.lat)}, {formatCoordinate(pick.lng)}
                </span>
                {canEditLocation && !pinMoved && " (local salvo)"}
              </>
            ) : (
              "Esta sala ainda não tem um local no mundo."
            )}
          </p>

          {canEditLocation && (
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                disabled={!pick || !pinMoved}
                onClick={() => {
                  signalingClient.setRoomLocation(pick);
                  if (celebrating) closePopup(true);
                }}
                className="flex-1 rounded-lg bg-zinc-950 px-4 py-2 text-xs font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
              >
                {saved ? "Salvar novo local" : "Salvar local"}
              </button>
              {celebrating && (
                <button
                  type="button"
                  onClick={() => closePopup(false)}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Agora não
                </button>
              )}
              {saved && (
                <button
                  type="button"
                  onClick={() => {
                    signalingClient.setRoomLocation(null);
                    setPick(null);
                  }}
                  className="rounded-lg border border-red-300 px-4 py-2 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                >
                  Remover do mapa
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {view === "limit" && (
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            Quantas pessoas cabem na sala ao mesmo tempo. Quem chega depois de cheia vê um aviso
            e não entra. Você e os administradores nunca são barrados pelo próprio limite.
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Agora: <span className="font-medium text-zinc-700 dark:text-zinc-300">
              {state.peers.filter((p) => p.role !== "moderator").length + 1}
            </span>{" "}
            na sala.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={MIN_ROOM_MEMBER_LIMIT}
              max={MAX_ROOM_MEMBER_LIMIT}
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
              placeholder="Sem limite"
              aria-label="Limite de participantes"
              className="w-28 rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-950 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
            <button
              type="button"
              onClick={() => {
                const parsed = Number(limitInput);
                signalingClient.setRoomMemberLimit(
                  limitInput.trim() === "" || !Number.isFinite(parsed) ? null : parsed
                );
              }}
              className="flex-1 rounded-lg bg-zinc-950 px-3 py-2 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              Salvar
            </button>
          </div>
          {/* Only offered once there is one to lift — "remover" on a room that
              never had a limit is a button that does nothing. */}
          {state.roomMemberLimit !== null && (
            <button
              type="button"
              onClick={() => {
                setLimitInput("");
                signalingClient.setRoomMemberLimit(null);
              }}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900"
            >
              Tirar o limite
            </button>
          )}
          <p className="text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
            Entre {MIN_ROOM_MEMBER_LIMIT} e {MAX_ROOM_MEMBER_LIMIT}. Baixar o limite não expulsa
            quem já está aqui — vale de agora em diante.
          </p>
        </div>
      )}

      {/* View: Permissions */}
      {view === "permissions" && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Ao desativar uma opção, apenas o dono e os administradores da sala continuam autorizados a
            utilizá-la.
          </p>
          <ul className="flex flex-col gap-1.5">
            {PERMISSION_ROWS.map(({ key, label, icon: Icon }) => {
              const allowed = state.roomPermissions[key];
              return (
                <li key={key}>
                  <button
                    type="button"
                    disabled={!isManager}
                    onClick={() => signalingClient.setRoomPermission(key, !allowed)}
                    aria-pressed={allowed}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-3.5 py-2.5 text-left text-xs font-medium transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:bg-zinc-900"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Icon
                        className={`h-4.5 w-4.5 shrink-0 ${
                          allowed
                            ? "text-zinc-900 dark:text-zinc-100"
                            : "text-zinc-400 dark:text-zinc-600"
                        }`}
                      />
                      <span className="min-w-0 text-zinc-800 dark:text-zinc-200">{label}</span>
                    </span>
                    <span
                      className={`relative h-5 w-9 shrink-0 rounded-full transition ${
                        allowed ? "bg-zinc-950 dark:bg-zinc-50" : "bg-zinc-300 dark:bg-zinc-700"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${
                          allowed
                            ? "left-[1.125rem] bg-white dark:bg-zinc-950"
                            : "left-0.5 bg-white dark:bg-zinc-300"
                        } shadow-sm`}
                      />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
