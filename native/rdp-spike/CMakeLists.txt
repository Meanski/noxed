# Windows build for the RDP sidecar.
#
# macOS builds the sidecar via the Makefile + build-freerdp-static.sh (a trimmed
# from-source static FreeRDP). On Windows the easiest self-contained path is
# vcpkg's static triplet, which ships static FreeRDP 3 plus its transitive deps
# (OpenSSL, zlib, ...). Configure with the vcpkg toolchain so find_package
# resolves everything:
#
#   vcpkg install freerdp:x64-windows-static
#   cmake -S native/rdp-spike -B native/rdp-spike/build \
#     -DCMAKE_TOOLCHAIN_FILE=<vcpkg>/scripts/buildsystems/vcpkg.cmake \
#     -DVCPKG_TARGET_TRIPLET=x64-windows-static -DCMAKE_BUILD_TYPE=Release
#   cmake --build native/rdp-spike/build --config Release
#
# Produces rdp-sidecar.exe, which electron-builder bundles via win.extraResources.
cmake_minimum_required(VERSION 3.16)
project(rdp_sidecar C)

set(CMAKE_C_STANDARD 11)

# Link the CRT statically so the .exe doesn't depend on the VC++ redistributable.
if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

# FreeRDP 3 from vcpkg. The CONFIG packages export imported targets that carry
# their static transitive dependencies, so we don't enumerate OpenSSL/zlib here.
find_package(FreeRDP CONFIG REQUIRED)
find_package(FreeRDP-Client CONFIG REQUIRED)
find_package(WinPR CONFIG REQUIRED)

add_executable(rdp-sidecar sidecar.c)
set_target_properties(rdp-sidecar PROPERTIES OUTPUT_NAME rdp-sidecar)

target_link_libraries(rdp-sidecar PRIVATE freerdp freerdp-client winpr)

# FreeRDP's vcpkg config pulls in transitive static deps (e.g. cjson) referenced
# by bare library name rather than a full path, so make the vcpkg static lib dir
# searchable for the linker.
if(DEFINED VCPKG_INSTALLED_DIR AND DEFINED VCPKG_TARGET_TRIPLET)
  target_link_directories(rdp-sidecar PRIVATE
    "${VCPKG_INSTALLED_DIR}/${VCPKG_TARGET_TRIPLET}/lib")
endif()

if(WIN32)
  # Sockets + crypto/security backends FreeRDP/WinPR pull in on Windows.
  target_link_libraries(rdp-sidecar PRIVATE ws2_32 crypt32 secur32 winmm bcrypt)
endif()
