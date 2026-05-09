#!/usr/bin/env python3
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, GLib
import sys
import signal

signal.signal(signal.SIGINT, signal.SIG_DFL)

url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173"

win = Gtk.Window(title="Git Glance", default_width=1100, default_height=780)
win.connect("destroy", Gtk.main_quit)
win.set_position(Gtk.WindowPosition.CENTER)

webview = WebKit2.WebView()
webview.load_uri(url)
win.add(webview)

win.show_all()
Gtk.main()
