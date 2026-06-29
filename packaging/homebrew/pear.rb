# Reference copy of the cask shape. The live cask is generated/updated by
# .github/workflows/homebrew.yml into the imbgar/homebrew-tap repo on each release.
cask "pear" do
  version "0.1.1"
  sha256 :no_check # the tap copy carries the real checksum

  url "https://github.com/imbgar/peaR/releases/download/v#{version}/peaR_#{version}_universal.dmg"
  name "peaR"
  desc "Terminal-native PR review control center"
  homepage "https://github.com/imbgar/peaR"

  app "peaR.app"

  caveats "peaR is unsigned — on first launch right-click it in /Applications and choose Open, or run: xattr -dr com.apple.quarantine /Applications/peaR.app"

  zap trash: [
    "~/Library/Application Support/dev.pear.app",
    "~/Library/Caches/dev.pear.app",
  ]
end
