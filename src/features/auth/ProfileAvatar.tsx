import { LocalProfileAvatar } from "../../../shared/contracts/auth";

export const profileAvatarChoices: Array<{ key: LocalProfileAvatar; label: string }> = [
  { key: "blue", label: "蓝色" },
  { key: "green", label: "绿色" },
  { key: "amber", label: "琥珀色" },
  { key: "slate", label: "岩灰色" }
];

export function ProfileAvatar({
  avatar = "blue",
  className = "",
  displayName
}: {
  avatar?: LocalProfileAvatar;
  className?: string;
  displayName: string;
}) {
  const initial = displayName.trim().slice(0, 1).toLocaleUpperCase() || "本";
  return <span aria-hidden="true" className={`profile-avatar is-${avatar} ${className}`.trim()}>{initial}</span>;
}
