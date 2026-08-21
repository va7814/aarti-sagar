# Advertisement images

Place advertisement images in this folder.

Recommended desktop creative size: **300 x 250 px** (4:3). Add multiple creatives using numbered names such as `left-ad-1.png`, `left-ad-2.png`, `left-ad-3.png` and `right-ad-1.png`, `right-ad-2.png`, `right-ad-3.png`. The app checks slots 1 through 10. JPG files with the same names are also supported.

Add each ad basename to `ads.json` under either `left` or `right`. The app prefers PNG and falls back to JPG if the PNG is missing. If both files are missing, that slot is removed completely. It displays all images in fixed 292 px wide slots with `object-fit: cover`. Keep important text and logos inside a centered safe area. Use compressed PNG or JPG, ideally below 300 KB.
