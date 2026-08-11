      @group(0) @binding(0) var smp: sampler;
      @group(0) @binding(1) var mip0: texture_2d<f32>;
      @group(0) @binding(2) var mip1: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(3) var mip2: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(4) var mip3: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(5) var mip4: texture_storage_2d<rgba8unorm, write>;

      var<workgroup> texels1: array<array<vec4f, 8>, 8>;
      var<workgroup> texels2: array<array<vec4f, 4>, 4>;
      var<workgroup> texels3: array<array<vec4f, 2>, 2>;

      // It doesn't seem like we need to check bounds. We bind a dummy texture.
      // for each mip level not used. We use textureSampleLevel for the top level
      // so it will clamp-to-edge. textureStore is speced to "not execute" if
      // out of bounds.

      @compute @workgroup_size(8, 8) fn cs(
        @builtin(local_invocation_id) lid: vec3u,
        @builtin(workgroup_id) wid: vec3u,
      ) {
        let blockXY = wid.xy;

        // generate mip1 from mip0
        {
          let mip1TexelXY = blockXY * 8 + lid.xy;
          let texelNdx = lid.xy;
          let mip0Size = textureDimensions(mip0, 0);

          let uv = vec2f(mip1TexelXY * 2 + 1) / vec2f(mip0Size);
          let c = textureSampleLevel(mip0, smp, uv, 0.0);
          texels1[texelNdx.y][texelNdx.x] = c;
          textureStore(mip1, mip1TexelXY, c);

          workgroupBarrier();
        }

        // generate mip2 from mip1
        if (lid.x < 4 && lid.y < 4) {
          let mip2TexelXY = blockXY * 4 + lid.xy;
          let texelNdx = lid.xy;
          let srcNdx = texelNdx * 2;
          let c0 = texels1[srcNdx.y    ][srcNdx.x    ];
          let c1 = texels1[srcNdx.y    ][srcNdx.x + 1];
          let c2 = texels1[srcNdx.y + 1][srcNdx.x    ];
          let c3 = texels1[srcNdx.y + 1][srcNdx.x + 1];
          let c = mix(mix(c0, c1, 0.5), mix(c2, c3, 0.5), 0.5);
          texels2[texelNdx.y][texelNdx.x] = c;
          textureStore(mip2, mip2TexelXY, c);
        }

        workgroupBarrier();

        // generate mip3 from mip2
        if (lid.x < 2 && lid.y < 2) {
          let mip3TexelXY = blockXY * 2 + lid.xy;
          let texelNdx = lid.xy;
          let srcNdx = texelNdx * 2;
          let c0 = texels2[srcNdx.y    ][srcNdx.x    ];
          let c1 = texels2[srcNdx.y    ][srcNdx.x + 1];
          let c2 = texels2[srcNdx.y + 1][srcNdx.x    ];
          let c3 = texels2[srcNdx.y + 1][srcNdx.x + 1];
          let c = mix(mix(c0, c1, 0.5), mix(c2, c3, 0.5), 0.5);
          texels3[texelNdx.y][texelNdx.x] = c;
          textureStore(mip3, mip3TexelXY, c);
        }

        workgroupBarrier();

        // generate mip4 from mip3
        if (lid.x < 1 && lid.y < 1) {
          let mip4TexelXY = blockXY + lid.xy;
          let texelNdx = lid.xy;
          let srcNdx = texelNdx * 2;
          let c0 = texels3[srcNdx.y    ][srcNdx.x    ];
          let c1 = texels3[srcNdx.y    ][srcNdx.x + 1];
          let c2 = texels3[srcNdx.y + 1][srcNdx.x    ];
          let c3 = texels3[srcNdx.y + 1][srcNdx.x + 1];
          let c = mix(mix(c0, c1, 0.5), mix(c2, c3, 0.5), 0.5);
          textureStore(mip4, mip4TexelXY, c);
        }

      }