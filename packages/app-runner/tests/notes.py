import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

window = Gtk.Window(title="Runner Notes")
window.set_default_size(420, 160)
entry = Gtk.Entry()


def changed(widget):
    with open("/data/text.txt", "w", encoding="utf-8") as output:
        output.write(widget.get_text())
    window.set_title("Runner Notes: " + widget.get_text())


entry.connect("changed", changed)
window.connect("destroy", Gtk.main_quit)
window.add(entry)
window.show_all()
entry.grab_focus()
Gtk.main()
