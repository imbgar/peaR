# Reference copy of the cask shape. The live cask is generated/updated by
# .github/workflows/homebrew.yml into the imbgar/homebrew-tap repo on each release.
cask "pear" do
  version "0.1.1"
  sha256 :no_check # the tap copy carries the real checksum

  url "https://github.com/imbgar/pear/releases/download/v#{version}/peaR_#{version}_universal.dmg"
  name "peaR"
  desc "Terminal-native PR review control center"
  homepage "https://github.com/imbgar/pear"

  app "peaR.app"

  zap trash: [
    "~/Library/Application Support/dev.pear.app",
    "~/Library/Caches/dev.pear.app",
  ]
end
