Rust files under @src/shaders directory are auto-generated reflection of the WGSL shader files under @shaders directory.
The auto-generation logic using `wgsl_to_wgpu` is defined in @build.rs .

# Adding a new shader

1. Add new `.wgsl` file into @shaders directory.
2. Add the name of the shader in the inline-list in @build.rs .
3. The reflection file is generated automatically in the @src/shaders .
4. Add the module declaration in the @src/shaders.rs .