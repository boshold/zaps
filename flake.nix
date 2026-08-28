{
  description = "ZAPS recording tools";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
    in
    {
      devShells = nixpkgs.lib.genAttrs systems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            FONTCONFIG_FILE = pkgs.makeFontsConf {
              fontDirectories = [ pkgs.nerd-fonts.jetbrains-mono ];
            };
          packages = [
            pkgs.ffmpeg
            pkgs.gifsicle
            pkgs.nerd-fonts.jetbrains-mono
            pkgs.tmux
            pkgs.vhs
          ];
          };
        }
      );
    };
}
