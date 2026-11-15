"use client";

import type { Profile } from "@bnl/contracts";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiPost } from "../../_components/api";

interface Props {
  readonly slot: 1 | 2;
  readonly profile: Profile | null;
  readonly avatars: readonly { id: string; emoji: string }[];
}

export function ProfileEditor({ slot, profile, avatars }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const idp = `p${slot}`;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    const res = await apiPost<Profile>("/api/v1/profiles", {
      id: profile?.id ?? crypto.randomUUID(),
      slot,
      display_name: String(form.get("display_name") ?? ""),
      grade: Number(form.get("grade")),
      avatar_id: String(form.get("avatar_id") ?? ""),
      ...(profile?.preferences ? { preferences: profile.preferences } : {}),
    });
    setBusy(false);
    setStatus(res.ok ? { ok: true, text: "Saved." } : { ok: false, text: res.message ?? "Could not save." });
    if (res.ok) router.refresh();
  }

  return (
    <section className="card" aria-labelledby={`${idp}-h`}>
      <h2 id={`${idp}-h`}>Child {slot}</h2>
      <form onSubmit={onSubmit}>
        <label htmlFor={`${idp}-name`}>Display name</label>
        <input id={`${idp}-name`} name="display_name" required maxLength={30} defaultValue={profile?.display_name ?? ""} autoComplete="off" />
        <label htmlFor={`${idp}-grade`}>Grade</label>
        <select id={`${idp}-grade`} name="grade" defaultValue={String(profile?.grade ?? 2)}>
          <option value="2">Grade 2</option>
          <option value="6">Grade 6</option>
        </select>
        <label htmlFor={`${idp}-avatar`}>Avatar</label>
        <select id={`${idp}-avatar`} name="avatar_id" defaultValue={profile?.avatar_id ?? avatars[0]?.id}>
          {avatars.map((a) => (
            <option key={a.id} value={a.id}>
              {a.emoji} {a.id}
            </option>
          ))}
        </select>
        <div>
          <button type="submit" disabled={busy}>{busy ? "Saving…" : profile ? "Save changes" : "Create profile"}</button>
        </div>
        {status && (
          <p className={`status ${status.ok ? "ok" : "err"}`} role={status.ok ? "status" : "alert"}>
            {status.text}
          </p>
        )}
      </form>
    </section>
  );
}
