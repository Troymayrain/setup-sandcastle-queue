declare const gitObjectIdBrand: unique symbol;

export type GitObjectId = string & {
  readonly [gitObjectIdBrand]: true;
};

/** 只接受 Git SHA-1 或 SHA-256 仓库产生的完整小写 object ID。 */
export function isGitObjectId(value: unknown): value is GitObjectId {
  return (
    typeof value === "string" &&
    (value.length === 40 || value.length === 64) &&
    /^[a-f0-9]+$/u.test(value)
  );
}
