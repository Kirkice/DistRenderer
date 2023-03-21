#pragma once

#include <vk.h>
#include <glm.hpp>
#include <functional>

struct CommonResources;
class TemporalAA;
class DeferredShading;
class RayTracedAO;
class RayTracedShadows;
class RayTracedReflections;
class DDGI;
class GroundTruthPathTracer;

class FastApproximateAA
{
public:
    FastApproximateAA(std::weak_ptr<dw::vk::Backend> backend, CommonResources* common_resources);
    ~FastApproximateAA();

    void render(dw::vk::CommandBuffer::Ptr                      cmd_buf,
                DeferredShading*                                deferred_shading,
                RayTracedAO*                                    ao,
                RayTracedShadows*                               shadows,
                RayTracedReflections*                           reflections,
                DDGI*                                           ddgi,
                GroundTruthPathTracer*                          ground_truth_path_tracer,
                std::function<void(dw::vk::CommandBuffer::Ptr)> gui_callback);
    void gui();
    inline bool      enabled() { return m_enabled; }

private:
    void create_pipeline();

private:
    std::weak_ptr<dw::vk::Backend> m_backend;
    CommonResources*               m_common_resources;
    uint32_t                       m_width;
    uint32_t                       m_height;

    bool                           m_enabled                       = true;
    float                          m_absolute_luma_threshold       = 0.08f;
    float                          m_relative_luma_threshold       = 0.25f;
    float                          m_console_charpness             = 4.0f;
    bool                           m_debug_mode                    = false;

    dw::vk::GraphicsPipeline::Ptr  m_pipeline;
    dw::vk::PipelineLayout::Ptr    m_pipeline_layout;
};