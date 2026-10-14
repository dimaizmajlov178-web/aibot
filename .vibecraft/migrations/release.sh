#!/usr/bin/env bash
# Выпуск новой версии шаблона. Запускать в корне репозитория шаблона.
#
#   ./.vibecraft/migrations/release.sh                      # обычный релиз
#   ./.vibecraft/migrations/release.sh --bootstrap <commit> # самая первая миграция
#   ./.vibecraft/migrations/release.sh --regenerate <base> <target> # rebuild a historical patch
# Historical regeneration preserves existing manifests and uses committed trees only.
# Do not regenerate migrations already consumed by projects without coordinating rollout.
#
# Предполагается, что версия в .vibecraft/template.json уже поднята и
# закоммичена вместе с изменениями шаблона.
set -euo pipefail

mig=".vibecraft/migrations"

die() { echo "ОШИБКА: $*" >&2; exit 1; }

mode="${1:-}"
case "$mode" in
    "") [ "$#" -eq 0 ] || die "неожиданные аргументы" ;;
    --bootstrap) [ "$#" -eq 2 ] || die "--bootstrap требует commit" ;;
    --regenerate) [ "$#" -eq 3 ] || die "--regenerate требует base и target" ;;
    *) die "неизвестный режим: $mode" ;;
esac

if [ "$mode" = "--regenerate" ]; then
    previous_release="$(git rev-parse --verify "$2^{commit}")"
    target_revision="$(git rev-parse --verify "$3^{commit}")"
else
    [ -z "$(git status --porcelain)" ] || die "есть незакоммиченные изменения — git diff их не увидит"
    target_revision="$(git rev-parse HEAD)"
fi

# Целевая версия: та, что владелец уже проставил в файле версии.
target_version="$(git show "$target_revision:.vibecraft/template.json" | node -e '
const fs = require("node:fs");
const {version} = JSON.parse(fs.readFileSync(0, "utf8"));
if (typeof version !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) process.exit(1);
process.stdout.write(version);
')" || die "некорректная версия в .vibecraft/template.json"
if [ "$mode" != "--regenerate" ]; then
    [ ! -e "$mig/$target_version.patch" ] || die "миграция $target_version уже опубликована"
fi

# База перехода: коммит, опубликовавший предыдущую версию. Им является тот
# коммит, который ДОБАВИЛ её патч, — это неизменяемый факт истории, в отличие
# от тега, который можно переставить или забыть проставить.
if [ "$mode" = "--regenerate" ]; then
    git merge-base --is-ancestor "$previous_release" "$target_revision" \
        || die "base должен быть предком target"
elif [ "$mode" = "--bootstrap" ]; then
    [ -n "${2:-}" ] || die "--bootstrap требует коммит исходного состояния"
    previous_release="$(git rev-parse --verify "$2^{commit}")"
    last_version=""
else
    last_version="$(ls "$mig"/*.patch 2>/dev/null | sed 's|.*/||; s|\.patch$||' | sort -V | tail -1 || true)"
    [ -n "$last_version" ] || die "миграций ещё нет — для первой укажи ./.vibecraft/migrations/release.sh --bootstrap <commit>"

    previous_release="$(git log --first-parent --diff-filter=A --format=%H -1 -- "$mig/$last_version.patch")"
    [ -n "$previous_release" ] || die "не нашёл коммит, добавивший $mig/$last_version.patch"

    # --first-parent важен при merge-воркфлоу: без него вернётся коммит ветки,
    # и патч построится относительно состояния, которого на основной ветке не было.
    newest="$(printf '%s\n%s\n' "$last_version" "$target_version" | sort -V | tail -1)"
    [ "$newest" = "$target_version" ] && [ "$last_version" != "$target_version" ] \
        || die "версия $target_version не старше последней опубликованной $last_version"
fi

echo "выпускаю $target_version, база: $(git log -1 --format='%h %s' "$previous_release")"

mkdir -p "$mig"
patch_file="$(mktemp)"
work=""
cleanup() {
    if [ -n "$work" ]; then
        git worktree remove --force "$work" >/dev/null 2>&1 || true
    fi
    rm -f "$patch_file"
}
trap cleanup EXIT
git diff --binary --full-index --no-ext-diff --no-textconv \
    "$previous_release" "$target_revision" -- . \
    ':(exclude).vibecraft/migrations/**' \
    > "$patch_file"
[ -s "$patch_file" ] || die "патч пустой — между base и target нет изменений"

# Verify the target revision, excluding separately distributed migration artifacts.
work="$(mktemp -d)"
git worktree add -q --detach "$work" "$previous_release"
git -C "$work" apply "$patch_file"
git -C "$work" add -A
git -C "$work" diff --cached --exit-code --no-ext-diff --no-textconv "$target_revision" -- . \
    ':(exclude).vibecraft/migrations/**' \
    || die "патч не воспроизводит целевой commit"

cp "$patch_file" "$mig/$target_version.patch"
if [ ! -e "$mig/$target_version.json" ]; then
    cat > "$mig/$target_version.json" <<JSON
{
  "scripts": ["typecheck", "build"],
  "description": "TODO: описание перехода до $target_version"
}
JSON
fi

echo "OK: патч воспроизводит $target_revision (без каталога миграций)"
echo "готово: $mig/$target_version.{patch,json} — заполни description и закоммить"
