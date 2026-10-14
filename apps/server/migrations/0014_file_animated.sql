-- Whether an uploaded image moves (an animated GIF or WebP), found in its bytes
-- at upload (isAnimated in src/api/media.ts). Animated images carry Slack's
-- thumb_360_gif, thumb_480_gif and deanimate_gif.
--
-- NULL for files that aren't images, and for images uploaded before this
-- column: GIFs among them count as animated, since a moving thumbnail of a
-- still GIF looks the same, while a still one of an animation would not.

ALTER TABLE files ADD COLUMN animated INTEGER;
