{
  description = "Campflare local development toolchain";

  # Nix supplies the toolchain: Node at the major in .node-version, pnpm, bun
  # (for `pnpm otui`), sqlite3 (to inspect local D1 state) and jq. Cloudflare's
  # runtime is not here: wrangler and workerd come from the pnpm lockfile, whose
  # versions must match @cloudflare/vitest-pool-workers. Nobody has to enter a
  # dev shell first: the Claude Code SessionStart hook (scripts/agent-env.sh)
  # puts `.#dev-tools` on PATH for every agent command, and `nix develop` gives
  # humans the same tools.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # .node-version is the one place the Node major lives (package.json#engines agrees).
      nodeMajor = nixpkgs.lib.trim (builtins.readFile ./.node-version);

      toolsFor = pkgs: [
          pkgs."nodejs_${nodeMajor}"
          # pnpm runs on the same Node major rather than bringing its own, and
          # switches itself to the version in package.json#packageManager.
          (pkgs.pnpm_10.override { nodejs-slim = pkgs."nodejs-slim_${nodeMajor}"; })
          pkgs.bun
          pkgs.sqlite
          pkgs.jq
        ];
    in
    {
      packages = forAllSystems (pkgs: {
        nodejs = pkgs."nodejs_${nodeMajor}";
        # One store path whose bin/ holds every tool, for prepending to PATH
        dev-tools = pkgs.buildEnv {
          name = "campflare-dev-tools";
          paths = toolsFor pkgs;
        };
        default = self.packages.${pkgs.system}.dev-tools;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = toolsFor pkgs;
        };
      });
    };
}
