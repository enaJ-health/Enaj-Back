import { NextResponse } from "next/server";
import { prisma } from "@/app/lib/prisma";

export async function OPTIONS() {
  return NextResponse.json({}, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  })
}

export async function POST(request: Request) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }

  try {
    const { clerkId, firstName, lastName, email } = await request.json()

    if (!clerkId || !email) {
      return NextResponse.json(
        { error: 'clerkId and email are required' },
        { status: 400, headers }
      )
    }

    // 1. First check whether this Clerk user is already linked.
    // If so, just return the existing profile.
    const existingAuth = await prisma.userAuth.findUnique({
      where: { clerkId },
      include: { user: true },
    })

    if (existingAuth) {
      return NextResponse.json(
        { user: existingAuth.user },
        { headers }
      )
    }

    // 2. No Clerk link yet. Check whether a profile already exists
    // for this email.
    const existingProfile = await prisma.userProfile.findUnique({
      where: { email },
    })

    if (existingProfile) {
      try {
        // Link this Clerk account to the existing profile.
        await prisma.userAuth.create({
          data: {
            clerkId,
            userId: existingProfile.id,
          },
        })
      } catch (error: any) {
        // Another request may have created the UserAuth at the same time.
        // If that happened, fetch the winning record instead of returning 500.
        if (error?.code === 'P2002') {
          const auth = await prisma.userAuth.findUnique({
            where: { clerkId },
            include: { user: true },
          })

          if (auth) {
            return NextResponse.json(
              { user: auth.user },
              { headers }
            )
          }
        }

        throw error
      }

      return NextResponse.json(
        { user: existingProfile },
        { headers }
      )
    }

    // 3. Neither the Clerk account nor email exists.
    // Create the profile and Clerk link together.
    try {
      const newProfile = await prisma.userProfile.create({
        data: {
          firstName: firstName || '',
          lastName: lastName || '',
          email,
          auth: {
            create: { clerkId },
          },
        },
      })

      return NextResponse.json(
        { user: newProfile },
        { status: 201, headers }
      )
    } catch (error: any) {
      // Handle the race where another clerk-sync request created
      // the user while this request was running.
      if (error?.code === 'P2002') {
        const auth = await prisma.userAuth.findUnique({
          where: { clerkId },
          include: { user: true },
        })

        if (auth) {
          return NextResponse.json(
            { user: auth.user },
            { headers }
          )
        }

        // The race may have occurred on the unique email instead.
        const profile = await prisma.userProfile.findUnique({
          where: { email },
        })

        if (profile) {
          return NextResponse.json(
            { user: profile },
            { headers }
          )
        }
      }

      throw error
    }
  } catch (error) {
    console.error('clerk-sync error:', error)

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers }
    )
  }
}

