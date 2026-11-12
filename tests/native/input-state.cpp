// Test the production scan against current and historical Win32 key-state bits,
// without injecting keys or requiring an interactive foreground window.
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cassert>
static SHORT keyStates[256] = {};
static int samples = 0;
static SHORT fixtureAsyncKeyState(int key) { ++samples; return keyStates[key]; }
#define GetAsyncKeyState fixtureAsyncKeyState
#define wmain consentMain
#include "../../native/consent.cpp"
#undef wmain
#undef GetAsyncKeyState

int wmain() {
  assert(allInputReleased());
  assert(samples == 254);
  for (const int key : {VK_LBUTTON, VK_RBUTTON, VK_MBUTTON, VK_XBUTTON1, VK_XBUTTON2, VK_LCONTROL, VK_RMENU, 0x41, VK_F24}) {
    keyStates[key] = 1; // "Pressed since last query" is not a held key.
    assert(allInputReleased());
    keyStates[key] = static_cast<SHORT>(0x8000);
    assert(!allInputReleased());
    keyStates[key] = static_cast<SHORT>(0x8001);
    assert(!allInputReleased());
    keyStates[key] = 0;
  }
  assert(!inputContext(nullptr, 0, nullptr));
  std::puts("INPUT_STATE_BITS_PASSED");
  return 0;
}
