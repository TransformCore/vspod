import unittest
from unittest.mock import Mock, patch

import hashlib
import os
import struct
import tempfile

from agent import MAX_RECTS, Agent, add_rect, cursor_fingerprints, xcursor_frames


class InputBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.agent = Agent.__new__(Agent)
        self.agent.d = Mock()
        self.agent.focus = None
        self.agent.last_input = None
        self.agent.pressed = set()
        self.agent.buttons = set()
        self.agent.send = Mock()
        self.agent.activate = Mock()
        self.agent.root_size = (4096, 2160)
        self.agent.windows = {
            1: {"window": Mock(), "dirty": False,
                "meta": {"width": 900, "height": 650, "x": 100, "y": 120}}
        }

    def test_unknown_window_is_explicitly_rejected(self):
        self.assertTrue(self.agent.command({"action": "key", "id": 99, "key": 38, "down": True}))
        self.assertEqual(self.agent.send.call_args.args[0]["type"], "rejected")
        self.agent.activate.assert_not_called()

    def test_resize_limits_and_boolean_dimensions(self):
        for width, height in [(299, 650), (2401, 650), (900, 199), (900, 1401), (True, 650)]:
            with self.subTest(width=width, height=height), self.assertRaises(ValueError):
                self.agent.command({"action": "resize", "id": 1, "width": width, "height": height})
        self.agent.command({"action": "resize", "id": 1, "width": 820, "height": 600})
        self.agent.windows[1]["window"].configure.assert_called_once_with(width=820, height=600)

    def test_invalid_keycodes_and_states(self):
        for key, down in [(7, True), (256, True), (True, True), (38, 1)]:
            with self.subTest(key=key, down=down), self.assertRaises(ValueError):
                self.agent.command({"action": "key", "id": 1, "key": key, "down": down})

    def test_pointer_bounds_and_coordinate_mapping(self):
        for x, y, button in [(-16385, 0, 0), (0, 16385, 0), (1.5, 0, 0), (0, 0, 8)]:
            with self.subTest(x=x, y=y, button=button), self.assertRaises(ValueError):
                self.agent.command({"action": "mouse", "id": 1, "x": x, "y": y, "button": button, "down": True})
        # Points outside the window (over a host popup, or beyond the frame) keep their true root position
        # rather than being clamped onto the window edge, where they would hover the guest menu bar.
        for x, y, expected in [(-1, -30, {"x": 99, "y": 90}), (950, 700, {"x": 1050, "y": 820})]:
            with self.subTest(x=x, y=y), patch("agent.xtest.fake_input") as injected:
                self.agent.command({"action": "mouse", "id": 1, "x": x, "y": y, "button": 0, "down": False})
                self.assertEqual(injected.call_args_list[0].kwargs, expected)
        # Motion off the guest root is dropped; button events are clamped so a release is never lost.
        with patch("agent.xtest.fake_input") as injected:
            self.agent.command({"action": "mouse", "id": 1, "x": -200, "y": 0, "button": 0, "down": False})
            injected.assert_not_called()
            self.agent.command({"action": "mouse", "id": 1, "x": -200, "y": -500, "button": 1, "down": False})
            self.assertEqual(injected.call_args_list[0].kwargs, {"x": 0, "y": 0})
        with patch("agent.xtest.fake_input") as injected:
            self.agent.command({"action": "mouse", "id": 1, "x": 25, "y": 30, "button": 1, "down": True})
            self.assertEqual(injected.call_args_list[0].kwargs, {"x": 125, "y": 150})
            self.assertEqual(self.agent.buttons, {1})

    def test_key_tracking_releases_every_held_key(self):
        with patch("agent.xtest.fake_input") as injected:
            self.agent.command({"action": "key", "id": 1, "key": 38, "down": True})
            self.assertEqual(self.agent.pressed, {38})
            self.agent.release()
            self.assertFalse(self.agent.pressed)
            self.assertEqual(injected.call_count, 2)

    def test_unsupported_action_is_not_a_success(self):
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            self.agent.command({"action": "execute", "id": 1})


class DamageRectTests(unittest.TestCase):
    def test_overlapping_rectangles_merge_transitively(self):
        rects = []
        add_rect(rects, (0, 0, 10, 10))
        add_rect(rects, (20, 0, 30, 10))
        add_rect(rects, (8, 0, 22, 5))
        self.assertEqual(rects, [(0, 0, 30, 10)])

    def test_disjoint_rectangles_stay_separate(self):
        rects = []
        add_rect(rects, (0, 0, 10, 10))
        add_rect(rects, (50, 50, 60, 60))
        self.assertEqual(sorted(rects), [(0, 0, 10, 10), (50, 50, 60, 60)])

    def test_too_many_rectangles_collapse_to_bounding_box(self):
        rects = []
        for i in range(MAX_RECTS + 1):
            add_rect(rects, (i * 20, 0, i * 20 + 5, 5))
        self.assertEqual(rects, [(0, 0, MAX_RECTS * 20 + 5, 5)])



def xcursor(images):
    """Builds a minimal Xcursor file from (size, width, height, pixel bytes) chunks."""
    header, toc, chunks = 16, b"", b""
    offset = header + 12 * len(images)
    for size, width, height, pixels in images:
        toc += struct.pack("<III", 0xFFFD0002, size, offset + len(chunks))
        chunks += struct.pack("<IIIIIIIII", 36, 0xFFFD0002, size, 1, width, height, 0, 0, 0) + pixels
    return b"Xcur" + struct.pack("<III", header, 0x10000, len(images)) + toc + chunks


class CursorFingerprintTests(unittest.TestCase):
    def test_frames_are_parsed_and_truncated_files_are_ignored(self):
        data = xcursor([(24, 1, 2, b"\x01" * 8), (48, 2, 1, b"\x02" * 8)])
        self.assertEqual(list(xcursor_frames(data)), [(24, b"\x01" * 8), (48, b"\x02" * 8)])
        self.assertEqual(list(xcursor_frames(data[:-4])), [(24, b"\x01" * 8)])
        self.assertEqual(list(xcursor_frames(b"nope")), [])

    def test_aliases_share_a_fingerprint(self):
        with tempfile.TemporaryDirectory() as directory:
            for name, fill in [("text", b"\x03"), ("xterm", b"\x03"), ("pointer", b"\x04")]:
                with open(os.path.join(directory, name), "wb") as handle:
                    handle.write(xcursor([(48, 1, 1, fill * 4)]))
            table = cursor_fingerprints(directory)
        self.assertEqual(table[hashlib.sha1(b"\x03" * 4).digest()], ["text", "xterm"])
        self.assertEqual(table[hashlib.sha1(b"\x04" * 4).digest()], ["pointer"])
        self.assertEqual(cursor_fingerprints("/nonexistent"), {})


if __name__ == "__main__":
    unittest.main()
