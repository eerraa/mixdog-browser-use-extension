// Independent ABI bindings for Microsoft's documented desktop
// IUserConsentVerifierInterop / UserConsentVerifier contract.
// No credential, PIN, biometric data, or authentication fallback is received.
// Contract: https://learn.microsoft.com/windows/win32/api/userconsentverifierinterop/
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <unknwn.h>
#include <cstdio>
#include <cwchar>
#include <cstdlib>
#include <cstring>
#include <string>

using HStr = void*;
struct Inspectable : IUnknown {
  virtual HRESULT STDMETHODCALLTYPE GetIids(ULONG*, IID**) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetRuntimeClassName(HStr*) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetTrustLevel(INT*) = 0;
};
struct AsyncEnum : Inspectable {
  virtual HRESULT STDMETHODCALLTYPE put_Completed(IUnknown*) = 0;
  virtual HRESULT STDMETHODCALLTYPE get_Completed(IUnknown**) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetResults(INT*) = 0;
};
struct AsyncInfo : Inspectable {
  virtual HRESULT STDMETHODCALLTYPE get_Id(UINT*) = 0;
  virtual HRESULT STDMETHODCALLTYPE get_Status(INT*) = 0;
  virtual HRESULT STDMETHODCALLTYPE get_ErrorCode(HRESULT*) = 0;
  virtual HRESULT STDMETHODCALLTYPE Cancel() = 0;
  virtual HRESULT STDMETHODCALLTYPE Close() = 0;
};
struct ConsentStatics : Inspectable {
  virtual HRESULT STDMETHODCALLTYPE CheckAvailabilityAsync(AsyncEnum**) = 0;
  virtual HRESULT STDMETHODCALLTYPE RequestVerificationAsync(HStr, AsyncEnum**) = 0;
};
struct ConsentInterop : Inspectable {
  virtual HRESULT STDMETHODCALLTYPE RequestVerificationForWindowAsync(HWND, HStr, REFIID, void**) = 0;
};

const IID consentStatics = {0xaf4f3f91,0x564c,0x4ddc,{0xb8,0xb5,0x97,0x34,0x47,0x62,0x7c,0x65}};
const IID consentInterop = {0x39e050c3,0x4e74,0x441a,{0x8d,0xc0,0xb8,0x11,0x04,0xdf,0x94,0x9c}};
const IID verificationOperation = {0xfd596ffd,0x2318,0x558f,{0x9d,0xbe,0xd2,0x1d,0xf4,0x37,0x64,0xa5}};
const IID asyncInfo = {0x00000036,0,0,{0xc0,0,0,0,0,0,0,0x46}};

static int report(const char* mode, HRESULT hr, INT result) {
  const bool verified = !std::strcmp(mode, "verify") && SUCCEEDED(hr) && result == 0;
  std::printf("{\"mode\":\"%s\",\"verified\":%s,\"result\":%d,\"hresult\":\"0x%08lx\"}\n",
    mode, verified ? "true" : "false", result, static_cast<unsigned long>(hr));
  return SUCCEEDED(hr) ? 0 : 1;
}

static HRESULT awaitResult(AsyncEnum* operation, HWND owner, DWORD ownerPid, INT* result) {
  AsyncInfo* info = nullptr;
  HRESULT hr = operation->QueryInterface(asyncInfo, reinterpret_cast<void**>(&info));
  if (FAILED(hr)) return hr;
  const ULONGLONG deadline = GetTickCount64() + 120000;
  for (;;) {
    INT status = 0;
    hr = info->get_Status(&status);
    if (FAILED(hr)) break;
    if (status == 1) { hr = operation->GetResults(result); break; }
    if (status == 2) { hr = HRESULT_FROM_WIN32(ERROR_CANCELLED); break; }
    if (status == 3) {
      HRESULT error = E_FAIL;
      hr = info->get_ErrorCode(&error);
      if (SUCCEEDED(hr)) hr = error;
      break;
    }
    DWORD currentPid = 0;
    if (owner) GetWindowThreadProcessId(owner, &currentPid);
    if (GetTickCount64() >= deadline || (owner && (!IsWindow(owner) || currentPid != ownerPid))) {
      info->Cancel();
      hr = HRESULT_FROM_WIN32(ERROR_CANCELLED);
      break;
    }
    Sleep(25);
  }
  info->Close();
  info->Release();
  return hr;
}

int wmain(int argc, wchar_t** argv) {
  const bool availability = argc == 2 && !std::wcscmp(argv[1], L"--availability");
  const bool verification = argc == 4 && !std::wcscmp(argv[1], L"--verify");
  if (!availability && !verification) return report("invalid", E_INVALIDARG, -1);
  HWND owner = nullptr;
  DWORD ownerPid = 0;
  std::wstring message;
  if (verification) {
    wchar_t* end = nullptr;
    owner = reinterpret_cast<HWND>(std::wcstoull(argv[2], &end, 16));
    if (!owner || *end || !IsWindow(owner)) return report("verify", E_INVALIDARG, -1);
    const DWORD expectedPid = std::wcstoul(argv[3], &end, 10);
    GetWindowThreadProcessId(owner, &ownerPid);
    if (*end || !expectedPid || ownerPid != expectedPid) return report("verify", E_ACCESSDENIED, -1);
    char bytes[8193];
    const size_t length = std::fread(bytes, 1, sizeof(bytes), stdin);
    if (!length || length > 8192) return report("verify", E_INVALIDARG, -1);
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes, static_cast<int>(length), nullptr, 0);
    if (count <= 0) return report("verify", E_INVALIDARG, -1);
    message.resize(count);
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes, static_cast<int>(length), message.data(), count);
    SecureZeroMemory(bytes, sizeof(bytes));
  }
  HMODULE combase = LoadLibraryExW(L"combase.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!combase) return report(availability ? "availability" : "verify", HRESULT_FROM_WIN32(GetLastError()), -1);
  const auto initialize = reinterpret_cast<HRESULT (WINAPI*)(INT)>(GetProcAddress(combase, "RoInitialize"));
  const auto uninitialize = reinterpret_cast<void (WINAPI*)()>(GetProcAddress(combase, "RoUninitialize"));
  const auto createString = reinterpret_cast<HRESULT (WINAPI*)(PCWSTR, UINT, HStr*)>(GetProcAddress(combase, "WindowsCreateString"));
  const auto deleteString = reinterpret_cast<HRESULT (WINAPI*)(HStr)>(GetProcAddress(combase, "WindowsDeleteString"));
  const auto factory = reinterpret_cast<HRESULT (WINAPI*)(HStr, REFIID, void**)>(GetProcAddress(combase, "RoGetActivationFactory"));
  if (!initialize || !uninitialize || !createString || !deleteString || !factory) {
    FreeLibrary(combase);
    return report(availability ? "availability" : "verify", E_NOINTERFACE, -1);
  }
  HRESULT hr = initialize(1); // RO_INIT_MULTITHREADED
  if (FAILED(hr)) { FreeLibrary(combase); return report("initialize", hr, -1); }
  const wchar_t className[] = L"Windows.Security.Credentials.UI.UserConsentVerifier";
  HStr name = nullptr;
  hr = createString(className, static_cast<UINT>(std::wcslen(className)), &name);
  AsyncEnum* operation = nullptr;
  if (SUCCEEDED(hr) && availability) {
    ConsentStatics* verifier = nullptr;
    hr = factory(name, consentStatics, reinterpret_cast<void**>(&verifier));
    if (SUCCEEDED(hr)) { hr = verifier->CheckAvailabilityAsync(&operation); verifier->Release(); }
  } else if (SUCCEEDED(hr)) {
    ConsentInterop* verifier = nullptr;
    hr = factory(name, consentInterop, reinterpret_cast<void**>(&verifier));
    if (SUCCEEDED(hr)) {
      HStr prompt = nullptr;
      hr = createString(message.data(), static_cast<UINT>(message.size()), &prompt);
      if (SUCCEEDED(hr)) {
        hr = verifier->RequestVerificationForWindowAsync(owner, prompt, verificationOperation,
          reinterpret_cast<void**>(&operation));
        deleteString(prompt);
      }
      verifier->Release();
    }
  }
  if (name) deleteString(name);
  INT result = -1;
  if (SUCCEEDED(hr) && operation) hr = awaitResult(operation, owner, ownerPid, &result);
  if (operation) operation->Release();
  uninitialize();
  FreeLibrary(combase);
  return report(availability ? "availability" : "verify", hr, result);
}
