#version 450

// ------------------------------------------------------------------------
// INPUTS -----------------------------------------------------------------
// ------------------------------------------------------------------------

layout(location = 0) in vec2 inUV;

// ------------------------------------------------------------------------
// OUTPUTS ----------------------------------------------------------------
// ------------------------------------------------------------------------

layout(location = 0) out vec4 FS_OUT_Color;

// ------------------------------------------------------------------------
// DESCRIPTOR SETS --------------------------------------------------------
// ------------------------------------------------------------------------

layout(set = 0, binding = 0) uniform sampler2D s_Color;

// ------------------------------------------------------------------------
// PUSH CONSTANTS ---------------------------------------------------------
// ------------------------------------------------------------------------

layout(push_constant) uniform PushConstants
{
    float   absolute_luma_threshold;
    float   relative_luma_threshold;
    float   console_charpness;
    int     debug_mode;
}
u_PushConstants;

// ------------------------------------------------------------------------
// FUNCTIONS --------------------------------------------------------------
// ------------------------------------------------------------------------

//究极抗锯齿
#define FXAA_MAX_EAGE_SEARCH_SAMPLE_COUNT 12

#define ScreenParams vec4(1280, 720, 1.000521, 1.000926)

float edgeSearchSteps[FXAA_MAX_EAGE_SEARCH_SAMPLE_COUNT] = {
    1, 1, 1, 1, 1,
    1.5, 2, 2, 2, 2,
    4, 8
};

struct FXAACrossData{
    vec4 M;
    vec4 N;
    vec4 S;
    vec4 W;
    vec4 E;
};

struct FXAACornerData{
    vec4 NW;
    vec4 NE;
    vec4 SW;
    vec4 SE;
};

struct FXAAEdge{
    vec2 dir;
    vec2 normal;
    bool isHorz;
    float lumaEdge; //往normal方向偏移0.5个像素的亮度
    vec4 oppRGBL;
};

float rgb2luma(vec3 color)
{
    return dot(color, vec3(0.299, 0.587, 0.114));
}

vec4 SampleLinear(sampler2D tex, vec2 uv)
{
    return texture(tex, uv);
}

vec4 SampleRGBLumaLinear(sampler2D tex, vec2 uv)
{
    vec3 color = SampleLinear(tex, uv).rgb;
    return vec4(color, rgb2luma(color));
}

///采集上下左右4个像素 + 中心像素
FXAACrossData SampleCross(sampler2D tex, vec2 uv, vec4 offset)
{
    FXAACrossData crossData;
    crossData.M = SampleRGBLumaLinear(tex, uv);
    crossData.S = SampleRGBLumaLinear(tex, uv + vec2(0, - offset.y));
    crossData.N = SampleRGBLumaLinear(tex, uv + vec2(0, offset.y));
    crossData.W = SampleRGBLumaLinear(tex, uv + vec2(- offset.x, 0));
    crossData.E = SampleRGBLumaLinear(tex, uv + vec2(offset.x, 0));
    return crossData;
}

vec4 CalculateContrast(in FXAACrossData cross)
{
    float lumaMin = min(min(min(cross.N.a, cross.S.a), min(cross.W.a,cross.E.a)), cross.M.a);
    float lumaMax = max(max(max(cross.N.a,cross.S.a), max(cross.W.a, cross.E.a)), cross.M.a);
    float lumaContrast = lumaMax - lumaMin;
    return vec4(lumaContrast, lumaMin, lumaMax, 0);
}

//offset由(x,y,-x,-y)组成
FXAACornerData SampleCorners(sampler2D tex, vec2 uv,vec4 offset)
{
    FXAACornerData cornerData;
    vec3 rgbNW = SampleLinear(tex,uv + offset.zy).rgb;
    vec3 rgbSW = SampleLinear(tex, uv + offset.zw).rgb;
    vec3 rgbNE = SampleLinear(tex, uv + offset.xy).rgb;
    vec3 rgbSE = SampleLinear(tex, uv + offset.xw).rgb;

    cornerData.NW = vec4(rgbNW, rgb2luma(rgbNW));
    cornerData.NE = vec4(rgbNE, rgb2luma(rgbNE));
    cornerData.SW = vec4(rgbSW, rgb2luma(rgbSW));
    cornerData.SE = vec4(rgbSE, rgb2luma(rgbSE));
    return cornerData;
}

FXAAEdge GetEdge(in FXAACrossData cross, in FXAACornerData corner)
{
    FXAAEdge edge;

    float lumaM = cross.M.a;
    float lumaN = cross.N.a;
    float lumaS = cross.S.a;
    float lumaW = cross.W.a;
    float lumaE = cross.E.a;

    float lumaGradS = lumaS - lumaM;
    float lumaGradN = lumaN - lumaM;
    float lumaGradW = lumaW - lumaM;
    float lumaGradE = lumaE - lumaM;

    float lumaGradH = abs(lumaGradW + lumaGradE);
    float lumaGradV = abs(lumaGradS + lumaGradN);

    float lumaNW = corner.NW.a;
    float lumaNE = corner.NE.a;
    float lumaSW = corner.SW.a;
    float lumaSE = corner.SE.a;

    lumaGradH = abs(lumaNW + lumaNE - 2 * lumaN)
    + 2 * lumaGradH
    + abs(lumaSW + lumaSE - 2 * lumaS);

    lumaGradV = abs(lumaNW + lumaSW - 2 * lumaW)
    + 2 * lumaGradV
    + abs(lumaNE + lumaSE - 2 * lumaE);

    bool isHorz = lumaGradV >= lumaGradH;
    edge.isHorz = isHorz;
    if (isHorz)
    {
        float s = sign(abs(lumaGradN) - abs(lumaGradS));
        edge.dir = vec2(1, 0);
        edge.normal = vec2(0, s);
        edge.lumaEdge = s > 0 ? (lumaN + lumaM) * 0.5: (lumaS + lumaM) * 0.5;
        edge.oppRGBL = s > 0 ? cross.N: cross.S;
    }
    else
    {
        float s = sign(abs(lumaGradE) - abs(lumaGradW));
        edge.dir = vec2(0, 1);
        edge.normal = vec2(s, 0);
        edge.lumaEdge = s > 0 ? (lumaE + lumaM) * 0.5: (lumaW + lumaM) * 0.5;
        edge.oppRGBL = s > 0 ? cross.E: cross.W;
    }
    return edge;
}

float GetLumaGradient(FXAAEdge edge, FXAACrossData crossData)
{
    float luma1, luma2;
    float lumaM = crossData.M.a;
    if (edge.isHorz)
    {
        luma1 = crossData.S.a;
        luma2 = crossData.N.a;
    }
    else
    {
        luma1 = crossData.W.a;
        luma2 = crossData.E.a;
    }
    return max(abs(lumaM - luma1),abs(lumaM - luma2));
}

float GetEdgeBlend(sampler2D tex, vec2 uv,FXAAEdge edge, FXAACrossData crossData)
{
    vec2 invScreenSize = (ScreenParams.zw - 1);

    float lumaM = crossData.M.a;
    float lumaGrad = GetLumaGradient(edge, crossData);
    float lumaGradScaled = lumaGrad * 0.25;
    uv += edge.normal * 0.5 * invScreenSize;

    vec2 dir = edge.dir;

    float lumaStart = edge.lumaEdge;

    vec4 rgblP, rgblN;

    vec2 posP = vec2(0, 0);
    vec2 posN = vec2(0, 0);
    bool endP = false;
    bool endN = false;

    for (uint i = 0; i < FXAA_MAX_EAGE_SEARCH_SAMPLE_COUNT; i++)
    {
        float step = edgeSearchSteps[i];
        if (!endP)
        {
            posP += step * dir;
            rgblP = SampleRGBLumaLinear(tex, uv + posP * invScreenSize);
            endP = abs(rgblP.a - lumaStart) > lumaGradScaled;
        }
        if (!endN)
        {
            posN -= step * dir;
            rgblN = SampleRGBLumaLinear(tex, uv + posN * invScreenSize);
            endN = abs(rgblN.a - lumaStart) > lumaGradScaled;
        }
        if (endP && endN)
        {
            break;
        }
    }

    posP = abs(posP);
    posN = abs(posN);
    float dstP = max(posP.x, posP.y);
    float dstN = max(posN.x, posN.y);
    float dst, lumaEnd;

    if (dstP > dstN) {
        dst = dstN;
        lumaEnd = rgblN.a;
    }else{
        dst = dstP;
        lumaEnd = rgblP.a;
    }
    if ((lumaM - lumaStart) * (lumaEnd - lumaStart) > 0){
        return 0;
    }
    //blend的范围为0~0.5
    return 0.5 - dst / (dstP + dstN);
}

vec3 aces_film(vec3 x)
{
    float a = 2.51f;
    float b = 0.03f;
    float c = 2.43f;
    float d = 0.59f;
    float e = 0.14f;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0f, 1.0f);
}

// ------------------------------------------------------------------------
// MAIN -------------------------------------------------------------------
// ------------------------------------------------------------------------

void main()
{
    vec4 outColor = vec4(0,0,0,1);
    vec2 invTextureSize = (ScreenParams.zw - 1);
    vec4 offset = vec4(1,1,-1,-1) * invTextureSize.xyxy * 0.5;
    FXAACornerData corner = SampleCorners(s_Color, inUV, offset);
    corner.NE.a += 1.0 / 384.0;
    vec4 rgblM = SampleRGBLumaLinear(s_Color, inUV);

    float maxLuma = max(max(corner.NW.a, corner.NE.a), max(corner.SW.a, corner.SE.a));
    float minLuma = min(min(corner.NW.a, corner.NE.a), min(corner.SW.a, corner.SE.a));
    float lumaContrast = max(rgblM.a, maxLuma) - min(rgblM.a, minLuma);
    float edgeContrastThreshold = max(u_PushConstants.absolute_luma_threshold, maxLuma * u_PushConstants.relative_luma_threshold);

    if (lumaContrast > edgeContrastThreshold) {
        vec2 dir;
        // dir.x = (corner.SW.a + corner.SE.a) - (corner.NW.a + corner.NE.a);
        // dir.y = (corner.NW.a + corner.SW.a) - (corner.NE.a + corner.SE.a);
        float sWMinNE = corner.SW.a - corner.NE.a;
        float sEMinNW = corner.SE.a - corner.NW.a;
        dir.x = sWMinNE + sEMinNW;
        dir.y = sWMinNE - sEMinNW;

        dir = normalize(dir);

        vec4 rgblP1 = SampleRGBLumaLinear(s_Color, inUV + dir * invTextureSize * 0.5);
        vec4 rgblN1 = SampleRGBLumaLinear(s_Color, inUV - dir * invTextureSize * 0.5);

        float dirAbsMinTimesC = min(abs(dir.x), abs(dir.y)) * u_PushConstants.console_charpness;
        vec2 dir2 = clamp(dir / dirAbsMinTimesC, vec2(-2,-2), vec2(2,2));

        vec4 rgblP2 = SampleRGBLumaLinear(s_Color, inUV + dir2 * invTextureSize * 2);
        vec4 rgblN2 = SampleRGBLumaLinear(s_Color, inUV - dir2 * invTextureSize * 2);

        vec4 rgblA = rgblP1 + rgblN1;
        vec4 rgblB = (rgblP2 + rgblN2) * 0.25 + rgblA * 0.25;

        bool twoTap = rgblB.a < minLuma || rgblB.a > maxLuma;

        if (twoTap)
        {
            rgblB.rgb = rgblA.rgb * 0.5;
        }

        outColor = vec4(rgblB.rgb, 1);
    }
    else
    {
        if(u_PushConstants.debug_mode > 0.5)
            outColor = vec4(0,0,0,1);
        else
            outColor = vec4(rgblM.rgb,1);
    }

    // HDR tonemap and gamma correct
    outColor.rgb = aces_film(outColor.rgb);
    outColor.rgb = pow(outColor.rgb, vec3(1.0 / 2.2));

    FS_OUT_Color = vec4(outColor.rgb, 1.0);
}

// ------------------------------------------------------------------------