import importlib.util,unittest
from unittest.mock import patch
from types import SimpleNamespace
s=importlib.util.spec_from_file_location('adapter','scripts/amazon-local-api.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_failed_location_preserves_old(self):
  session=SimpleNamespace(located='10001')
  def fail(s,z):s.located=z;return False
  with patch.object(m,'_original_location',fail):self.assertFalse(m.set_location(session,'90001'))
  self.assertEqual(session.located,'10001')
 def test_visible_zip_required(self):
  self.assertFalse(m.location('<div id="glow-ingress-line2">China</div>','10001')['verified'])
  self.assertTrue(m.location('<div id="glow-ingress-line2">New York 10001</div>','10001')['verified'])
  self.assertFalse(m.location('<div id="glow-ingress-line2">100019</div>','10001')['verified'])
 def test_invalid_zip_before_network(self):
  with self.assertRaises(ValueError):m.collect('product','B0819W9CSW','abc')
unittest.main()
