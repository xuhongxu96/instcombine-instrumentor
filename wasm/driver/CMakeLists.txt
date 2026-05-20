# Minimal InstCombine driver, built into a wasm bundle by emscripten.
#
# Added to the LLVM build via:
#   -DLLVM_EXTERNAL_PROJECTS=instcombine_driver
#   -DLLVM_EXTERNAL_INSTCOMBINE_DRIVER_SOURCE_DIR=<path-to-this-dir>

cmake_minimum_required(VERSION 3.20)

set(LLVM_LINK_COMPONENTS
  Analysis
  AsmParser
  BitReader
  Core
  InstCombine
  IRReader
  Passes
  Support
  TransformUtils
)

add_llvm_executable(instcombine_driver instcombine_driver.cpp)

if(EMSCRIPTEN)
  # .js loader + .wasm sidecar; ESM module so Vite can dynamic-import it from a worker.
  set_target_properties(instcombine_driver PROPERTIES SUFFIX ".js")
  target_link_options(instcombine_driver PRIVATE
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sFORCE_FILESYSTEM=1"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sINITIAL_MEMORY=64MB"
    "-sSTACK_SIZE=4MB"
    "-sEXPORTED_RUNTIME_METHODS=['FS','callMain','ccall']"
    "-sEXPORTED_FUNCTIONS=['_main','_dump_iteration_info_external']"
    "-sENVIRONMENT=worker,node"
    "-sEXIT_RUNTIME=0"
    "-sINVOKE_RUN=0"
    "-sASSERTIONS=0"
  )
endif()
