"""The contact sheet's "total" render (tools/renderviews.py): its frame takes in every view, and
its route overlay numbers the views and draws a line per pan or cut."""
import os, re, sys, unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import renderviews  # noqa: E402


class Total(unittest.TestCase):
    views = [{"x": 50, "y": 50, "z": 80, "zoom": 1, "overview": True, "pan": 0.1},
             {"x": 90, "y": 52, "z": 80, "zoom": -1, "pan": 0.5},
             {"x": 90, "y": 52, "z": 80, "zoom": -1, "rotation": 2},
             {"x": 150, "y": 20, "z": 120, "zoom": 0, "pan": 0.3}]

    def test_frame_zooms_out_until_every_view_fits(self):
        angles = [0, 0, 2, 2]
        frame, rotation = renderviews.total_frame(self.views, angles, (1920, 1080))
        self.assertEqual(rotation, 0)
        self.assertEqual((frame["x"], frame["y"]), (50, 50))
        self.assertGreater(frame["zoom"], 1)  # (150, 20) is off the overview's frame
        near, _ = renderviews.total_frame(self.views[:3], angles[:3], (1920, 1080))
        self.assertEqual(near["zoom"], 1)  # never closer than the overview

    def test_overlay_numbers_views_and_draws_each_leg(self):
        frame, rotation = renderviews.total_frame(self.views, [0, 0, 2, 2], (1920, 1080))
        svg = renderviews.route_overlay(self.views, frame, rotation, (1920, 1080))
        labels = re.findall(r'<text class="num"[^>]*>([^<]*)</text>', svg)
        self.assertEqual(labels, ["1", "2,3", "4"])  # views 2 and 3 share a spot
        lines = re.findall(r"<line([^>]*)>", svg)
        self.assertEqual(len(lines), 3)  # 1->2, 3->4, 4->1 (2->3 is the same spot)
        self.assertEqual(sum('class="cut"' in l for l in lines), 1)  # view 3 cuts to 4


if __name__ == "__main__":
    unittest.main()
