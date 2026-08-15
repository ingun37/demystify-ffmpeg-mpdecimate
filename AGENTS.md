Currently trying to deprecate @rust and @web and redevelop everything in @web-v2 . Goal is to take all the lessons learned from trial and errors of the old projects and build a newer, cleaner, fitter program.

## Notable differences

- Ditch Rust, and use WebGPU APIs straight from Typescript
- Preserve YUV planes when reading VideoFrame into WebGPU memory (No intermediate RGB conversion)