# Put the podprompt command on your PATH for this shell.
#
#   source /path/to/podprompt/activate.sh
#
# This figures out where it lives, so it works from anywhere and does not
# need editing. Nothing else is changed — no variables are exported beyond
# PATH, and running it twice is harmless.
#
# This affects the current shell only. To make it permanent, put the line
# this prints into your ~/.bashrc or ~/.zshrc instead of sourcing this.
#
# Needs bash or zsh (it reads BASH_SOURCE / ${(%):-%x}, which fish and csh
# do not have). For fish:
#     fish_add_path /path/to/podprompt/bin

if [ -n "$BASH_SOURCE" ]; then
    _podprompt_self="${BASH_SOURCE[0]}"
elif [ -n "$ZSH_VERSION" ]; then
    _podprompt_self="${(%):-%x}"
else
    echo "activate.sh needs bash or zsh. Add this to your PATH manually:" >&2
    echo "  <podprompt checkout>/bin" >&2
    return 1 2>/dev/null || exit 1
fi

# Resolve symlinks so sourcing a linked copy still finds the real checkout.
while [ -L "$_podprompt_self" ]; do
    _podprompt_link_dir="$(cd -P "$(dirname "$_podprompt_self")" && pwd)"
    _podprompt_self="$(readlink "$_podprompt_self")"
    case "$_podprompt_self" in
        /*) ;;
        *) _podprompt_self="${_podprompt_link_dir}/${_podprompt_self}" ;;
    esac
done

_podprompt_bin="$(cd -P "$(dirname "$_podprompt_self")" && pwd)/bin"

if [ ! -x "$_podprompt_bin/podprompt" ]; then
    echo "activate.sh: no executable podprompt found at $_podprompt_bin" >&2
else
    case ":$PATH:" in
        *":$_podprompt_bin:"*) ;;                 # already there
        *) PATH="$_podprompt_bin:$PATH"; export PATH ;;
    esac
    echo "podprompt is on your PATH for this shell."
    echo "To make it permanent, add this to your ~/.bashrc or ~/.zshrc:"
    echo "  export PATH=\"$_podprompt_bin:\$PATH\""
fi

unset _podprompt_self _podprompt_bin _podprompt_link_dir
